#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters and actions the way Alfred does and validate the JSON.

Google Translate and DeepL are replaced by a local mock server; the tests never reach the real services.
Set TR_LIVE=1 to also run one request against the real Google endpoint (skipped by default).
"""
import json, os, plistlib, re, shutil, subprocess, sys, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
KEY = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d:fx"


# ---------- mock services ----------

def detect(q):
    if re.search(r"[Ѐ-ӿ]", q):
        return "ru"
    if re.match(r"(?i)(hallo|guten|danke|ich )", q):
        return "de"
    if re.match(r"(?i)(bonjour|merci)", q):
        return "fr"
    return "en"


class Mock:
    requests = []
    google_status = {}  # client -> forced HTTP status
    deepl_status = None
    lock = threading.Lock()


def google_answer(q, sl, tl, dts):
    src = detect(q) if sl == "auto" else sl
    text = "[%s] %s" % (tl, q)
    sentences = [[text, q, None, None, 10]]
    if tl == "ja" and "rm" in dts:
        sentences.append([None, None, "romaji " + q, None])
    if src == "ru" and "rm" in dts:
        sentences.append([None, None, None, "privet"])
    d = [sentences, None, src, None, None, None, 1, [], [[src], None, [1], [src]]]
    if q == "helo":
        d[7] = ["<b><i>hello</i></b>", "hello", [1], None, None, False]
    if q == "helo wrld":
        d[7] = ["<b><i>hello world</i></b>", "hello world", [1], None, None, True]
    if q == "run" and "bd" in dts:
        d[1] = [["noun", ["Lauf", "Run"], [["Lauf", ["run", "race"], None, 0.2, "der"], ["Run", ["run"], None, 0.1, "der"]], "run", 1],
                ["verb", ["laufen"], [["laufen", ["run", "walk"], None, 0.5]], "run", 2]]
        d[5] = [["run", None, [[text, None, True, False, [10]], ["rennen", None, True, False, [8]]], [[0, 3]], "run", 0, 0]]
        d += [None, None]
        d.append([["verb", [[["sprint", "race", "dash"], "id1"]], "run"]])
        d.append([["verb", [["move fast on foot", "id1", "the dog <b>ran</b> across"]], "run"]])
        d.append([[["I <b>run</b> every morning", None, None, None, None, "id2"]]])
    return d


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, status, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.handle_any(b"")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.handle_any(self.rfile.read(n))

    def handle_any(self, raw):
        u = urlparse(self.path)
        qs = parse_qs(u.query, keep_blank_values=True)
        rec = {"path": u.path, "qs": qs, "body": raw.decode("utf-8", "replace"), "headers": dict(self.headers), "method": self.command}
        with Mock.lock:
            Mock.requests.append(rec)
        if u.path == "/translate_a/single":
            client = qs.get("client", [""])[0]
            q = parse_qs(rec["body"]).get("q", [""])[0]
            rec["q"] = q
            if client in Mock.google_status:
                st = Mock.google_status[client]
                return self.send(st, "<html><body>Too many requests</body></html>" if st == 429 else "error", "text/html")
            if "SERVERERR" in q:
                return self.send(500, "oops", "text/plain")
            if "BLOCKED" in q:
                return self.send(200, "<!DOCTYPE html><html>sorry</html>", "text/html")
            return self.send(200, json.dumps(google_answer(q, qs["sl"][0], qs["tl"][0], qs.get("dt", []))))
        if u.path == "/translate_tts":
            return self.send(200, b"ID3fake-mp3-" + qs.get("idx", ["0"])[0].encode(), "audio/mpeg")
        if u.path.startswith("/v2/"):
            auth = self.headers.get("Authorization", "")
            if auth != "DeepL-Auth-Key " + KEY:
                return self.send(403, json.dumps({"message": "Forbidden"}))
            if Mock.deepl_status:
                return self.send(Mock.deepl_status, json.dumps({"message": "limit"}))
            if u.path == "/v2/usage":
                return self.send(200, json.dumps({"character_count": 12345, "character_limit": 500000}))
            if u.path == "/v2/languages":
                return self.send(200, json.dumps([{"language": c, "name": c} for c in ["DE", "EN-GB", "EN-US", "FR", "JA", "ZH-HANS", "ZH-HANT", "PT-BR", "UK"]]))
            if u.path == "/v2/translate":
                body = json.loads(rec["body"])
                rec["json"] = body
                text = body["text"][0]
                if "QUOTA" in text:
                    return self.send(456, json.dumps({"message": "Quota exceeded"}))
                src = body.get("source_lang") or detect(text).upper()
                return self.send(200, json.dumps({"translations": [{"detected_source_language": src, "text": "<%s> %s" % (body["target_lang"], text)}]}))
        self.send(404, "not found", "text/plain")


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 64  # long text sends several requests at once


SERVER = Server(("127.0.0.1", 0), Handler)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % SERVER.server_address[1]


# ---------- running the workflow ----------

class Env:
    """A fresh Alfred cache/data folder (with spaces, like Alfred's) per test."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="translate-test-")
        self.cache = os.path.join(self.root, "Caches", "Workflow Data", "io.github.x-o-r-r-o.translate")
        self.data = os.path.join(self.root, "Application Support", "Workflow Data", "io.github.x-o-r-r-o.translate")
        self.keychain = os.path.join(self.root, "keychain")
        os.makedirs(self.keychain)

    def base(self, extra):
        e = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": os.environ.get("HOME", "/tmp"),
            "alfred_workflow_cache": self.cache, "alfred_workflow_data": self.data,
            "alfred_workflow_bundleid": "io.github.x-o-r-r-o.translate",
            "TR_TEST": "1", "TR_GOOGLE_URL": BASE, "TR_DEEPL_URL": BASE, "TR_TEST_KEYCHAIN": self.keychain,
            "TR_TEST_CLIPBOARD": "", "TR_TEST_NOOPEN": "1", "TR_TEST_SYSLANG": "de-DE", "TR_UNTHROTTLED": "1",
            "TR_TEST_VOICES": "{}", "TR_TIMEOUT": "4",
        }
        e.update({k: str(v) for k, v in extra.items() if v is not None})
        for k in [k for k, v in extra.items() if v is None]:
            e.pop(k, None)
        return e

    def run(self, args, **extra):
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./translate.js"] + args, cwd=SRC,
                             env=self.base(extra), capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        return out.stdout

    def sf(self, query, cmd="filter", **extra):
        extra["tr_query"] = query
        data = json.loads(self.run([cmd], **extra))
        validate(data)
        return data["items"]

    def act(self, item, mod=None, **extra):
        """Run the action for a row as Alfred would: the item's (or modifier's) arg and variables."""
        src = item["mods"][mod] if mod else item
        assert src.get("valid", True) is not False, src
        v = dict(item.get("variables") or {}) if not mod else {}
        v.update(src.get("variables") or {})
        v.update(extra)
        out = self.run(["act", src["arg"]], **v).strip()
        return json.loads(out)["alfredworkflow"] if out else None

    def set_key(self, key=KEY):
        with open(os.path.join(self.keychain, "io.github.x-o-r-r-o.translate.deepl"), "w") as f:
            f.write(key)

    def history(self):
        p = os.path.join(self.data, "history.json")
        return json.load(open(p))["entries"] if os.path.exists(p) else []


def validate(data):
    assert isinstance(data.get("items"), list)
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert "\n" not in it["title"], it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m, it
            if m.get("valid", True) is not False:
                assert "arg" in m, it
        for k in ("tr_key",):
            assert KEY not in json.dumps(it.get("arg", "")), it


def titles(items):
    return [i["title"] for i in items]


def find(items, prefix):
    for i in items:
        if i["title"].startswith(prefix):
            return i
    raise AssertionError("no item starting with %r: %r" % (prefix, titles(items)))


def google_reqs():
    return [r for r in Mock.requests if r["path"] == "/translate_a/single"]


class Base(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        Mock.requests.clear()
        Mock.google_status.clear()
        Mock.deepl_status = None

    def tearDown(self):
        shutil.rmtree(self.e.root, ignore_errors=True)


# ---------- translating ----------

class TranslateTests(Base):
    def test_basic_translation_and_rows(self):
        it = self.e.sf("good morning")
        main = it[0]
        self.assertEqual(main["title"], "[de] good morning")
        self.assertEqual(main["arg"], "[de] good morning")
        self.assertIn("English → German", main["subtitle"])
        self.assertEqual(main["variables"]["tr_action"], "copy")
        self.assertEqual(main["mods"]["cmd"]["variables"]["tr_action"], "paste")
        self.assertEqual(main["mods"]["ctrl"]["variables"]["tr_action"], "speak")
        self.assertTrue(main["mods"]["alt"]["arg"].startswith("https://translate.google.com/?sl=en&tl=de&text=good%20morning"))
        self.assertEqual(main["mods"]["shift"]["arg"], "de>en [de] good morning")
        self.assertEqual(main["text"]["copy"], "[de] good morning")
        find(it, "Detected: English → German")
        r = google_reqs()[0]
        self.assertEqual(r["method"], "POST")
        self.assertEqual(r["qs"]["client"], ["gtx"])
        self.assertEqual(r["qs"]["sl"], ["auto"])
        self.assertIn("bd", r["qs"]["dt"])
        self.assertIn("alfred-translate", r["headers"].get("User-Agent", ""))

    def test_already_in_first_language_uses_second(self):
        it = self.e.sf("Hallo Welt")
        self.assertEqual(it[0]["title"], "[en] Hallo Welt")
        self.assertIn("German → English (already in German)", it[0]["subtitle"])
        # the second request names the detected source
        self.assertEqual(google_reqs()[-1]["qs"]["sl"], ["de"])
        self.assertEqual(it[0]["mods"]["shift"]["arg"], "en>de [en] Hallo Welt")

    def test_no_second_language(self):
        it = self.e.sf("hello there", TR_TEST_SYSLANG="en-US", tr_language2="en")
        self.assertEqual(it[0]["title"], "[en] hello there")
        row = find(it, "Already in English")
        self.assertEqual(row["autocomplete"], "hello there >")

    def test_configured_languages(self):
        it = self.e.sf("hello", tr_language1="fr", tr_language2="none")
        self.assertEqual(it[0]["title"], "[fr] hello")
        it = self.e.sf("hello", tr_language1="system", TR_TEST_SYSLANG="zh-Hans-CN,en")
        self.assertEqual(it[0]["title"], "[zh-CN] hello")
        it = self.e.sf("hello", TR_TEST_SYSLANG="pt-PT")
        self.assertEqual(it[0]["title"], "[pt-PT] hello")

    def test_language_tokens(self):
        self.assertEqual(self.e.sf(">fr hello")[0]["title"], "[fr] hello")
        self.assertEqual(self.e.sf("hello >fr")[0]["title"], "[fr] hello")
        self.assertEqual(self.e.sf("hello >french")[0]["title"], "[fr] hello")
        self.assertEqual(self.e.sf("hello >Deutsch")[0]["title"], "[de] hello")
        self.assertEqual(self.e.sf("hello >ger")[0]["title"], "[de] hello")  # unique prefix
        self.assertEqual(self.e.sf("hello >he")[0]["title"], "[iw] hello")  # alias
        self.assertEqual(self.e.sf("hello >zh-hant")[0]["title"], "[zh-TW] hello")
        it = self.e.sf("en>de Hallo")
        self.assertEqual(it[0]["title"], "[de] Hallo")  # explicit target: no automatic swap
        self.assertEqual(google_reqs()[-1]["qs"]["sl"], ["en"])
        find(it, "From: English → German")

    def test_several_targets(self):
        it = self.e.sf("hello >fr,ja")
        self.assertEqual(it[0]["title"], "[fr] hello")
        ja = find(it, "[ja] hello")
        self.assertIn("Japanese · romaji hello", ja["subtitle"])
        # the extra languages are fetched in the same run, in parallel
        self.assertEqual(sorted(r["qs"]["tl"][0] for r in google_reqs()), ["fr", "ja"])

    def test_also_translate_into(self):
        it = self.e.sf("hello", tr_more="fr, Japanese, xx, de")
        self.assertEqual(titles(it)[:3], ["[de] hello", "romaji hello", "[fr] hello"][:1] + titles(it)[1:3])
        find(it, "[fr] hello")
        find(it, "[ja] hello")
        self.assertEqual(sum(1 for t in titles(it) if t.startswith("[de]")), 1)
        # an extra language that is the text's own language is left out
        it = self.e.sf("hello", tr_more="en, fr")
        self.assertFalse([t for t in titles(it) if t.startswith("[en]")])

    def test_romanization(self):
        it = self.e.sf("hello >ja")
        row = find(it, "romaji hello")
        self.assertIn("Romanization", row["subtitle"])
        self.assertEqual(row["arg"], "romaji hello")
        it = self.e.sf("привет >en")
        self.assertIn("privet", find(it, "Detected: Russian").get("subtitle"))

    def test_dictionary_and_details(self):
        it = self.e.sf("run")
        lauf = find(it, "Lauf")
        self.assertIn("noun · der Lauf · run, race", lauf["subtitle"])
        self.assertEqual(lauf["arg"], "Lauf")
        find(it, "laufen")
        self.assertIn("Alternative", find(it, "rennen")["subtitle"])
        d = find(it, "move fast on foot")
        self.assertIn("Definition (verb)", d["subtitle"])
        self.assertIn("the dog ran across", d["subtitle"])
        self.assertEqual(d["variables"]["tr_dst"], "en")  # spoken in the source language
        find(it, "I run every morning")
        find(it, "sprint, race, dash")
        it = self.e.sf("run", tr_details="0")
        self.assertFalse([t for t in titles(it) if t.startswith("Lauf")])

    def test_spelling(self):
        it = self.e.sf("helo")
        row = find(it, "Did you mean “hello”?")
        self.assertEqual(row["autocomplete"], "hello")
        it = self.e.sf("helo >fr")
        self.assertEqual(find(it, "Did you mean")["autocomplete"], "hello >fr")
        it = self.e.sf("helo wrld")
        self.assertEqual(find(it, "Translated as “hello world”")["autocomplete"], "hello world")

    def test_clipboard_when_empty(self):
        it = self.e.sf("", TR_TEST_CLIPBOARD="  good night \n")
        self.assertEqual(it[0]["title"], "[de] good night")
        self.assertTrue(it[0]["subtitle"].startswith("Clipboard · "))
        self.assertEqual(find(it, "Detected")["autocomplete"], ">")
        it = self.e.sf(">fr", TR_TEST_CLIPBOARD="good night")
        self.assertEqual(it[0]["title"], "[fr] good night")
        it = self.e.sf("", TR_TEST_CLIPBOARD="good night", tr_clipboard="0")
        self.assertEqual(it[0]["title"], "Translate…")
        it = self.e.sf("")
        self.assertEqual(it[0]["title"], "Translate…")
        self.assertEqual(len(google_reqs()), 2)

    def test_unicode_quotes_newlines(self):
        q = 'Line one "quoted" $(rm -rf ~) `x` \'s\nLine two ‮evil‬ 😀'
        it = self.e.sf(q)
        main = it[0]
        self.assertEqual(main["arg"], "[de] " + q)
        self.assertNotIn("‮", main["title"])
        self.assertNotIn("\n", main["title"])
        self.assertEqual(google_reqs()[0]["q"], q)
        self.assertTrue(os.path.exists(main["quicklookurl"]))
        with open(main["quicklookurl"]) as f:
            self.assertIn("Line two", f.read())
        out = self.e.act(main)
        self.assertEqual(out["arg"], "[de] " + q)

    def test_long_text_is_split(self):
        para = ("This is a sentence that goes on. " * 40).strip()
        text = "\n\n".join([para] * 12)  # about 16,000 characters
        it = self.e.sf(text)
        reqs = google_reqs()
        self.assertGreater(len(reqs), 3)
        self.assertTrue(all(len(r["q"]) <= 4500 for r in reqs))
        self.assertEqual("".join(r["q"] for r in reqs).replace("\n", ""), text.replace("\n", ""))
        arg = it[0]["arg"]
        self.assertTrue(arg.startswith("trfile:"), arg[:40])
        out = self.e.act(it[0])
        self.assertEqual(out["arg"].count("\n\n"), 11)  # paragraph breaks are kept
        self.assertEqual(out["arg"].count("[de] "), len(reqs))
        self.assertEqual(it[0]["text"]["copy"], out["arg"])

    def test_very_long_text_is_cut(self):
        text = "word " * 7000
        it = self.e.sf(text)
        find(it, "Only the first 30,000 characters were translated")

    def test_picker(self):
        it = self.e.sf(">")
        self.assertGreater(len(it), 20)
        self.assertTrue(all(i["valid"] is False and i["autocomplete"].startswith(">") for i in it))
        it = self.e.sf("hello >g")
        de = find(it, "German")
        self.assertEqual(de["autocomplete"], "hello >de")
        it = self.e.sf(">jap")
        self.assertEqual(it[0]["autocomplete"], ">ja ")
        it = self.e.sf("hello >fr,j")
        self.assertIn("hello >fr,ja", [i["autocomplete"] for i in it])
        it = self.e.sf("hello fr>")
        self.assertTrue(it[0]["autocomplete"].startswith("hello fr>"))
        it = self.e.sf(">xq hello")
        self.assertEqual(it[0]["title"], "Unknown language “xq”")
        it = self.e.sf("hello >qqqq")
        self.assertEqual(it[0]["title"], "No language matches “qqqq”")
        # recently used languages come first
        self.e.act(self.e.sf("hello >uk")[0])
        self.assertEqual(self.e.sf(">")[0]["autocomplete"], ">uk ")
        self.assertFalse(google_reqs()[1:])

    def test_arrow_text_is_not_a_language(self):
        self.assertEqual(self.e.sf("a => b")[0]["title"], "[de] a => b")
        self.assertEqual(self.e.sf("x>y is true")[0]["title"], "[de] x>y is true")


class CacheAndLimitTests(Base):
    def test_cache(self):
        self.e.sf("cache me")
        self.e.sf("cache me")
        self.assertEqual(len(google_reqs()), 1)
        # a week later it asks again
        self.e.sf("cache me", TR_TEST_NOW=time.time() + 8 * 86400)
        self.assertEqual(len(google_reqs()), 2)

    def test_offline(self):
        it = self.e.sf("hello", TR_GOOGLE_URL="http://127.0.0.1:1")
        self.assertEqual(it[0]["title"], "Couldn’t reach Google Translate")
        self.assertEqual(it[0]["subtitle"], "Check your internet connection")
        # a cached translation from last week is shown while offline
        self.e.sf("hello")
        it = self.e.sf("hello", TR_GOOGLE_URL="http://127.0.0.1:1", TR_TEST_NOW=time.time() + 8 * 86400)
        self.assertEqual(it[0]["title"], "Offline: showing a translation from 8 days ago")
        self.assertEqual(it[1]["title"], "[de] hello")

    def test_rate_limit_switches_client_then_backs_off(self):
        Mock.google_status["gtx"] = 429
        it = self.e.sf("one")
        self.assertEqual(it[0]["title"], "[de] one")
        self.assertEqual([r["qs"]["client"][0] for r in google_reqs()], ["gtx", "dict-chrome-ex"])
        # gtx is left alone for a while
        self.e.sf("two")
        self.assertEqual(google_reqs()[-1]["qs"]["client"], ["dict-chrome-ex"])
        Mock.google_status["dict-chrome-ex"] = 429
        it = self.e.sf("three")
        self.assertEqual(it[0]["title"], "Google Translate is limiting requests")
        self.assertIn("Try again in", it[0]["subtitle"])
        self.assertEqual(it[0]["variables"]["tr_action"], "open")
        n = len(google_reqs())
        it = self.e.sf("four")  # no request while backing off
        self.assertEqual(len(google_reqs()), n)
        self.assertEqual(it[0]["title"], "Google Translate is limiting requests")
        # cached translations are still shown, and older ones with a note
        self.assertEqual(self.e.sf("one")[0]["title"], "[de] one")
        it = self.e.sf("one", TR_TEST_NOW=time.time() + 8 * 86400)
        self.assertEqual(it[1]["title"], "[de] one")
        self.assertEqual(it[0]["title"], "Google Translate is limiting requests: showing a translation from 8 days ago")

    def test_shared_request_budget(self):
        for i in range(12):
            self.e.sf("word %d" % i, TR_UNTHROTTLED=None)
        it = self.e.sf("word 99", TR_UNTHROTTLED=None)
        self.assertEqual(it[0]["title"], "Slowing down: too many translations in a few seconds")
        self.assertEqual(len(google_reqs()), 12)

    def test_errors(self):
        it = self.e.sf("SERVERERR")
        self.assertEqual(it[0]["title"], "Couldn’t get a translation from Google Translate: server error (HTTP 500)")
        self.assertTrue(it[0]["arg"].startswith("https://translate.google.com/"))
        it = self.e.sf("BLOCKED")
        self.assertEqual(it[0]["title"], "Google Translate is limiting requests")


# ---------- DeepL ----------

class DeepLTests(Base):
    def test_no_key_falls_back_to_google(self):
        it = self.e.sf("hello", tr_provider="deepl")
        self.assertEqual(it[0]["title"], "Translated by Google: no DeepL API key is saved")
        self.assertEqual(it[0]["autocomplete"], "apikey ")
        self.assertEqual(it[1]["title"], "[de] hello")

    def test_translate_with_key(self):
        self.e.set_key()
        it = self.e.sf("hello", tr_provider="deepl", tr_deepl_formality="prefer_more")
        self.assertEqual(it[0]["title"], "<DE> hello")
        self.assertIn("DeepL", it[0]["subtitle"])
        self.assertTrue(it[0]["mods"]["alt"]["arg"].startswith("https://www.deepl.com/translator#en/de/hello"))
        tr = [r for r in Mock.requests if r["path"] == "/v2/translate"][0]
        self.assertEqual(tr["json"]["formality"], "prefer_more")
        self.assertNotIn("source_lang", tr["json"])
        self.assertEqual(tr["headers"]["Content-Type"], "application/json")
        self.assertFalse(google_reqs())
        # the target list is fetched once and cached
        self.assertEqual(len([r for r in Mock.requests if r["path"] == "/v2/languages"]), 1)
        self.e.sf("hello again", tr_provider="deepl")
        self.assertEqual(len([r for r in Mock.requests if r["path"] == "/v2/languages"]), 1)

    def test_deepl_codes_and_second_language(self):
        self.e.set_key()
        it = self.e.sf("Hallo", tr_provider="deepl", tr_deepl_english="EN-GB")
        self.assertEqual(it[0]["title"], "<EN-GB> Hallo")
        it = self.e.sf("hello >zh-TW", tr_provider="deepl")
        self.assertEqual(it[0]["title"], "<ZH-HANT> hello")
        it = self.e.sf("hello >pt", tr_provider="deepl")
        self.assertEqual(it[0]["title"], "<PT-BR> hello")
        it = self.e.sf("fr>de merci", tr_provider="deepl")
        tr = [r for r in Mock.requests if r["path"] == "/v2/translate"][-1]
        self.assertEqual(tr["json"]["source_lang"], "FR")

    def test_unsupported_language_uses_google(self):
        self.e.set_key()
        it = self.e.sf("hello >sw", tr_provider="deepl")
        self.assertTrue(it[0]["title"].startswith("Translated by Google: DeepL doesn’t translate into Swahili"))
        self.assertEqual(it[1]["title"], "[sw] hello")
        it = self.e.sf("hello >fr,sw", tr_provider="deepl")
        self.assertEqual(it[0]["title"], "<FR> hello")
        self.assertIn("Google", find(it, "[sw] hello")["subtitle"])

    def test_bad_key_and_quota(self):
        self.e.set_key("ffffffff-4e5f-4a6b-8c7d-9e0f1a2b3c4d:fx")
        it = self.e.sf("hello", tr_provider="deepl")
        self.assertEqual(it[0]["title"], "Translated by Google: DeepL rejected your API key")
        self.e.set_key()
        it = self.e.sf("QUOTA test", tr_provider="deepl")
        self.assertEqual(it[0]["title"], "Translated by Google: DeepL’s monthly character limit is used up")
        self.assertEqual(it[1]["title"], "[de] QUOTA test")

    def test_deepl_offline(self):
        self.e.set_key()
        it = self.e.sf("hello", tr_provider="deepl", TR_DEEPL_URL="http://127.0.0.1:1")
        self.assertEqual(it[0]["title"], "Couldn’t reach DeepL")


class KeyTests(Base):
    def test_save_from_clipboard(self):
        it = self.e.sf("apikey", TR_TEST_CLIPBOARD=KEY)
        row = find(it, "Save API key from clipboard")
        self.assertEqual(row["arg"], "savekey")
        self.assertIn("••••", row["subtitle"])
        self.assertNotIn(KEY, row["subtitle"] + json.dumps(row.get("text")))
        find(it, "Get an API key…")
        cleared = os.path.join(self.e.root, "cleared")
        out = self.e.act(row, TR_TEST_CLIPBOARD=KEY, TR_TEST_CLIPBOARD_OUT=cleared)
        self.assertEqual(out["arg"], "API key saved")
        self.assertTrue(os.path.exists(cleared))
        it = self.e.sf(":key")
        self.assertEqual(find(it, "DeepL usage")["title"], "DeepL usage: 12,345 of 500,000 characters (2%)")
        rm = find(it, "Remove the saved API key")
        self.assertEqual(self.e.act(rm)["arg"], "API key removed")
        self.assertFalse(os.path.exists(os.path.join(self.e.keychain, "io.github.x-o-r-r-o.translate.deepl")))

    def test_typed_key(self):
        it = self.e.sf("apikey " + KEY)
        row = find(it, "Save typed API key")
        self.assertEqual(row["variables"]["tr_key"], KEY)
        it = self.e.sf("apikey not a key!")
        find(it, "That doesn’t look like a DeepL API key")
        out = self.e.act(row, tr_key="bad\nkey")
        self.assertIn("Couldn’t save the API key", out["arg"])


# ---------- actions, history, speech ----------

class ActionTests(Base):
    def test_copy_paste_and_history(self):
        it = self.e.sf("good evening")
        out = self.e.act(it[0])
        self.assertEqual(out, {"arg": "[de] good evening", "variables": {"tr_route": "copy"}})
        out = self.e.act(it[0], "cmd")
        self.assertEqual(out["variables"]["tr_route"], "paste")
        h = self.e.history()
        self.assertEqual(len(h), 1)
        self.assertEqual((h[0]["src"], h[0]["dst"], h[0]["text"], h[0]["result"]), ("en", "de", "good evening", "[de] good evening"))
        out = self.e.act(it[0], tr_enter="paste")
        # enter-pastes setting swaps the actions on new rows
        it = self.e.sf("good evening", tr_enter="paste")
        self.assertEqual(it[0]["variables"]["tr_action"], "paste")
        self.assertEqual(it[0]["mods"]["cmd"]["variables"]["tr_action"], "copy")

    def test_history_filter(self):
        for q in ["good evening", "thank you", "cat"]:
            self.e.act(self.e.sf(q)[0])
        it = self.e.sf("", cmd="history")
        self.assertEqual(titles(it)[:3], ["[de] cat", "[de] thank you", "[de] good evening"])
        self.assertEqual(it[-1]["title"], "Clear the history")
        it = self.e.sf("thank", cmd="history")
        self.assertEqual(titles(it), ["[de] thank you"])
        self.assertEqual(it[0]["mods"]["alt"]["arg"], "en>de thank you")
        out = self.e.act(it[0], "shift")
        self.assertEqual(out["arg"], "Removed from the history")
        self.assertEqual(len(self.e.history()), 2)
        self.assertEqual(self.e.sf("zzz", cmd="history")[0]["title"], "No matching translations")
        # home rows show recent translations
        it = self.e.sf("")
        self.assertEqual(it[1]["title"], "[de] cat")
        out = self.e.act(find(self.e.sf("", cmd="history"), "Clear the history"))
        self.assertEqual(out["arg"], "Cleared 2 translations from the history")
        self.assertEqual(self.e.sf("", cmd="history")[0]["title"], "No translations yet")

    def test_history_off_and_cap(self):
        self.e.act(self.e.sf("hello")[0], tr_history="0")
        self.assertEqual(self.e.history(), [])
        self.assertEqual(self.e.sf("", cmd="history", tr_history="0")[0]["title"], "The history is off")
        for i in range(3):
            self.e.act(self.e.sf("item %d" % i)[0], tr_history="2")
        self.assertEqual([h["text"] for h in self.e.history()], ["item 2", "item 1"])

    def test_open_swap_search(self):
        it = self.e.sf("hello")
        out = self.e.act(it[0], "alt")
        self.assertTrue(out["arg"].startswith("open https://translate.google.com/"))
        out = self.e.act(it[0], "shift")
        self.assertEqual(out["arg"], "search tra de>en [de] hello")
        out = self.e.act(it[0], "shift", keyword_translate="tr8")
        self.assertEqual(out["arg"], "search tr8 de>en [de] hello")
        # only Google Translate and DeepL pages open
        out = self.e.run(["act", "file:///etc/passwd"], tr_action="open")
        self.assertEqual(json.loads(out)["alfredworkflow"]["arg"], "")

    def test_speak(self):
        it = self.e.sf("hello")
        out = self.e.act(it[0], "ctrl", TR_TEST_VOICES='{"de": "Anna"}')
        self.assertEqual(out["arg"], "say -v Anna (de)")
        out = self.e.act(it[0], "ctrl")  # no macOS voice: Google's voice
        self.assertEqual(out["arg"], "afplay 1 (de)")
        tts = [r for r in Mock.requests if r["path"] == "/translate_tts"]
        self.assertEqual(tts[0]["qs"]["tl"], ["de"])
        self.assertEqual(tts[0]["qs"]["q"], ["[de] hello"])
        out = self.e.act(it[0], "ctrl", tr_speech="macos")
        self.assertTrue(out["arg"].startswith("Couldn’t speak German: no macOS voice"))
        long = "A sentence to read aloud. " * 30
        out = self.e.act(self.e.sf(long)[0], "ctrl")
        self.assertRegex(out["arg"], r"^afplay [4-9] \(de\)$")

    def test_resolve_only_reads_own_files(self):
        out = self.e.run(["act", "trfile:/etc/passwd"], tr_action="copy")
        self.assertEqual(json.loads(out)["alfredworkflow"]["arg"], "trfile:/etc/passwd")
        out = self.e.run(["act", "trfile:%s/out/result-/../../x.txt" % self.e.cache], tr_action="copy")
        self.assertIn("result-/../", json.loads(out)["alfredworkflow"]["arg"])

    def test_settings_rows(self):
        it = self.e.sf(":")
        self.assertEqual([t.split()[0] for t in titles(it)], ["apikey", ":history", ":clear", ":cache", ":config"])
        it = self.e.sf(":ca")
        self.assertEqual(titles(it), [":cache  Clear cached translations"])
        self.e.sf("hello")
        self.assertEqual(self.e.act(it[0])["arg"], "Cleared cached translations")
        self.e.sf("hello")
        self.assertEqual(len(google_reqs()), 2)
        self.assertEqual(self.e.act(find(self.e.sf(":config"), ":config"))["arg"], "config")
        # ":)" is text, not a setting
        self.assertEqual(self.e.sf(":)")[0]["title"], "[de] :)")
        self.assertEqual(self.e.sf(":zzz")[0]["title"], "[de] :zzz")


class InstantTests(Base):
    def test_replace_selection(self):
        out = json.loads(self.e.run(["instant"], tr_query="  good morning\n"))["alfredworkflow"]
        self.assertEqual(out, {"arg": "  [de] good morning\n", "variables": {"tr_route": "paste"}})
        self.assertEqual(self.e.history()[0]["result"], "[de] good morning")
        out = json.loads(self.e.run(["instant"], tr_query="Hallo"))["alfredworkflow"]
        self.assertEqual(out["arg"], "[en] Hallo")

    def test_errors(self):
        out = json.loads(self.e.run(["instant"], tr_query="   "))["alfredworkflow"]
        self.assertEqual(out["variables"]["tr_route"], "notify")
        out = json.loads(self.e.run(["instant"], tr_query="hi", TR_GOOGLE_URL="http://127.0.0.1:1"))["alfredworkflow"]
        self.assertEqual(out, {"arg": "Couldn’t reach Google Translate", "variables": {"tr_route": "notify"}})
        out = json.loads(self.e.run(["instant"], tr_query="hello", TR_TEST_SYSLANG="en", tr_language2="none"))["alfredworkflow"]
        self.assertEqual(out["arg"], "Couldn’t translate: the text is already in English")


# ---------- the built workflow ----------

class BuildTests(unittest.TestCase):
    def test_build_check(self):
        out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_plist(self):
        p = os.path.join(SRC, "info.plist")
        if not os.path.exists(p):
            self.skipTest("run tools/build.py first")
        info = plistlib.load(open(p, "rb"))
        self.assertEqual(info["bundleid"], "io.github.x-o-r-r-o.translate")
        kws = {o["config"]["keyword"] for o in info["objects"] if "keyword" in o["config"]}
        self.assertEqual(kws, {"{var:keyword_translate}", "{var:keyword_history}"})
        cfg = {c["variable"]: c for c in info["userconfigurationconfig"]}
        for v in ("keyword_translate", "keyword_history"):
            self.assertGreaterEqual(len(cfg[v]["config"]["default"]), 3)
        sfs = [o for o in info["objects"] if o["type"] == "alfred.workflow.input.scriptfilter"]
        self.assertEqual({o["config"]["queuemode"] for o in sfs if "translate" in o["config"]["keyword"]}, {2})
        langs = json.load(open(os.path.join(SRC, "languages.json")))
        codes = {c for c, _, _ in langs}
        for k in ("tr_language1", "tr_language2"):
            for _, v in cfg[k]["config"]["pairs"]:
                self.assertTrue(v in codes or v in ("system", "none"), v)
        self.assertNotIn("![", info["readme"])


@unittest.skipUnless(os.environ.get("TR_LIVE") == "1", "live test: set TR_LIVE=1")
class LiveTests(Base):
    def test_google(self):
        it = self.e.sf("thank you >it", TR_GOOGLE_URL="https://translate.googleapis.com", TR_TEST=None)
        self.assertEqual(it[0]["title"].lower(), "grazie")


if __name__ == "__main__":
    unittest.main()
