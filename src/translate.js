#!/usr/bin/osascript -l JavaScript
// Translate for Alfred — Google Translate (no key) or DeepL (API key), without dependencies.
// Usage: osascript -l JavaScript translate.js <command> [args…]
//   filter            Script Filter JSON for the query in $tr_query (the `tra` keyword)
//   history           Script Filter JSON for the query in $tr_query (the `trh` keyword)
//   act <arg>         run the action chosen in Alfred ($tr_action); prints what Alfred passes on
//   instant           translate the text in $tr_query for the "replace the selection" Hotkey
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("Security");
ObjC.bindFunction("kill", ["int", ["int", "int"]]);

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
// Alfred checkboxes arrive as "1"/"0" (older versions: "true"/"false")
function enabled(name, fallback) {
  return !/^(0|false|no|)$/i.test(env(name, fallback ? "1" : "0").trim());
}
function now() {
  const t = env("TR_TEST_NOW", ""); // test suite only: a fixed clock (epoch seconds)
  return t ? Number(t) : Date.now() / 1000;
}

const BUNDLE = env("alfred_workflow_bundleid", "io.github.x-o-r-r-o.translate");
const UA = "alfred-translate/1.0 (+https://github.com/x-o-r-r-o/alfred-translate)";
const TIMEOUT = Math.max(1, Number(env("TR_TIMEOUT", "8")) || 8); // seconds per request
const TESTING = env("TR_TEST", "") === "1";
// the test suite points the providers at a local mock server; tests never reach the real services
const trimSlash = (s) => s.replace(/\/+$/, "");
const GOOGLE_API = trimSlash(env("TR_GOOGLE_URL", TESTING ? "http://127.0.0.1:9" : "https://translate.googleapis.com"));
const DEEPL_API = env("TR_DEEPL_URL", TESTING ? "http://127.0.0.1:9" : "");
const GOOGLE_CHUNK = 4500; // characters per Google request (the endpoint stops at about 5,000)
const MAX_CHARS = 30000; // longer text is cut here
const MAX_SPEAK = 3000; // characters read aloud with Google’s voice
const HISTORY_TEXT_MAX = 5000; // characters kept per history entry
const INLINE_MAX = 5000; // longer results reach the action through a cache file (see act)
const FRESH = 7 * 86400; // cached translations are used without asking again for a week…
const STALE = 30 * 86400; // …and kept for a month, to show while offline
const CACHE_FILES = 1000;
const GOOGLE_CLIENTS = ["gtx", "dict-chrome-ex"]; // the second client is tried when the first one is rate limited
// Requests per service across every process (each keystroke is a separate process): [max, seconds]…
const LIMITS = { google: [[20, 10], [150, 60]], deepl: [[10, 10], [60, 60]], tts: [[20, 10]] };

// ---------- small helpers ----------

const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// one display line: bidi overrides and control characters removed, whitespace collapsed
function oneLine(s, max = 200) {
  s = String(s == null ? "" : s).replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\s\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd() + "…";
}
function plural(n, one, many) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many || one + "s"}`;
}
function stripTags(s) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
// FNV-1a, 2 × 32 bit: a short, stable key for cache file names
function hash(s) {
  const one = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return one(2166136261) + one(84696351);
}

// ---------- files ----------

const FM = $.NSFileManager.defaultManager;
const PID = $.NSProcessInfo.processInfo.processIdentifier;
function mkdirs(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}
function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}alfred-translate`));
}
function dataDir() {
  return mkdirs(env("alfred_workflow_data", `${$.NSTemporaryDirectory().js}alfred-translate-data`));
}
function exists(p) {
  return FM.fileExistsAtPath(p);
}
function readFile(p) {
  if (!exists(p)) return null;
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}
// atomic (temp file + rename): Alfred may kill a Script Filter at any moment (queuemode 2)
function writeFile(p, text) {
  return $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, $());
}
function removeFile(p) {
  FM.removeItemAtPathError(p, $());
}
function readJSON(p, fallback) {
  const t = readFile(p);
  if (t === null) return fallback;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch (e) {
    return fallback;
  }
}
function mtime(p) {
  const a = FM.attributesOfItemAtPathError(p, $());
  return a.isNil() ? 0 : a.fileModificationDate.timeIntervalSince1970;
}
function listDir(dir) {
  const a = FM.contentsOfDirectoryAtPathError(dir, $());
  return a.isNil() ? [] : a.js.map((s) => s.js);
}

// ---------- processes ----------

// Run a program with argv (never a shell) and optional stdin; returns {status, stdout, stderr}.
function exec(path, args, input) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const inP = $.NSPipe.pipe, outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardInput = input === undefined ? $.NSFileHandle.fileHandleWithNullDevice : inP;
  task.standardOutput = outP;
  task.standardError = errP;
  if (!task.launchAndReturnError($())) return { status: -1, stdout: "", stderr: `cannot run ${path}` };
  if (input !== undefined) {
    inP.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
    inP.fileHandleForWriting.closeFile;
  }
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const str = (d) => {
    const s = $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding);
    return s.isNil() ? "" : s.js;
  };
  return { status: task.terminationStatus, stdout: str(out), stderr: str(err) };
}
// Start a program that outlives this script (speech); returns its pid or 0
function spawn(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const nul = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = nul;
  task.standardOutput = nul;
  task.standardError = nul;
  return task.launchAndReturnError($()) ? task.processIdentifier : 0;
}
function alive(pid) {
  return Number.isInteger(pid) && pid > 1 && $.kill(pid, 0) === 0;
}

// Serialise a read-modify-write across processes: mkdir is atomic. The owner's pid goes inside, so a
// lock left by a killed process (Alfred terminates the previous Script Filter run on each keystroke)
// is taken over at once, and one without a pid after a few seconds.
function withLock(dir, fn) {
  const until = Date.now() + 3000;
  let got = false;
  while (!(got = FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $(), $()))) {
    const age = Date.now() / 1000 - mtime(dir);
    const owner = Number(readFile(`${dir}/pid`));
    if (exists(dir) && (age > 10 || age < -60 || (owner > 1 && !alive(owner)))) removeFile(dir);
    else if (Date.now() > until) break;
    else $.NSThread.sleepForTimeInterval(0.03);
  }
  if (got) writeFile(`${dir}/pid`, String(PID));
  try {
    return fn();
  } finally {
    if (got) removeFile(dir);
  }
}

// ---------- configuration ----------

function kw(name, fallback) {
  return env(name, "").trim() || fallback; // a required field can still arrive empty
}
const kwTranslate = () => kw("keyword_translate", "tra");
const kwHistory = () => kw("keyword_history", "trh");
function providerId() {
  return env("tr_provider", "google") === "deepl" ? "deepl" : "google";
}
function historyMax() {
  const n = parseInt(env("tr_history", "100"), 10);
  return n > 0 ? Math.min(n, 5000) : 0;
}
const NAMES = { google: "Google Translate", deepl: "DeepL" };

// ---------- languages ----------

let LANGS = null;
function langs() {
  if (LANGS) return LANGS;
  let list = [];
  try {
    list = JSON.parse(readFile("languages.json") || "[]");
  } catch (e) {}
  const byCode = new Map();
  for (const [code, name, native] of list) byCode.set(code, { code, name, native: native || "" });
  LANGS = { list: [...byCode.values()], byCode };
  return LANGS;
}
// Other spellings of Google's codes: ISO codes, script tags, the codes macOS and DeepL use
const ALIASES = new Map([
  ["he", "iw"], ["jw", "jv"], ["fil", "tl"], ["nb", "no"], ["nn", "no"], ["zh", "zh-CN"], ["zh-hans", "zh-CN"], ["zh-cn", "zh-CN"],
  ["zh-sg", "zh-CN"], ["zh-hant", "zh-TW"], ["zh-tw", "zh-TW"], ["zh-hk", "zh-TW"], ["pt-br", "pt"], ["pt-pt", "pt-PT"], ["mni", "mni-Mtei"],
  ["en-us", "en"], ["en-gb", "en"], ["iw", "iw"], ["cn", "zh-CN"], ["jp", "ja"], ["kr", "ko"], ["ua", "uk"], ["cz", "cs"], ["gr", "el"],
  ["dk", "da"], ["se", "sv"], ["中文", "zh-CN"], ["汉语", "zh-CN"], ["繁體", "zh-TW"], ["chinese", "zh-CN"], ["mandarin", "zh-CN"], ["portuguese", "pt"], ["farsi", "fa"], ["tagalog", "tl"],
]);
function langName(code) {
  if (code === "auto") return "Auto-detect";
  const l = langs().byCode.get(code);
  return l ? l.name : code || "Unknown";
}
// A code or name to Google's code, or null. Unique name prefixes count (“ger” is German).
function resolveLang(s, allowAuto) {
  if (!s) return null;
  const t = s.trim();
  const low = t.toLowerCase();
  if (allowAuto && (low === "auto" || low === "detect")) return "auto";
  const L = langs();
  for (const l of L.list) if (l.code.toLowerCase() === low) return l.code;
  const alias = ALIASES.get(low);
  if (alias && L.byCode.has(alias)) return alias;
  const base = low.split(/[-_]/)[0];
  if (base !== low) {
    const a2 = ALIASES.get(base);
    if (L.byCode.has(base)) return base;
    if (a2 && L.byCode.has(a2)) return a2;
  }
  for (const l of L.list) if (l.name.toLowerCase() === low || (l.native && l.native.toLowerCase() === low)) return l.code;
  if (low.length < (/^[\x00-\x7f]*$/.test(low) ? 3 : 2)) return null; // “ger”, but also “中文”, “日本”
  const hits = L.list.filter((l) => l.name.toLowerCase().startsWith(low) || (l.native && l.native.toLowerCase().startsWith(low)));
  return hits.length === 1 ? hits[0].code : null;
}
// Languages for the picker, best matches first
function searchLangs(q, recent) {
  const low = (q || "").trim().toLowerCase();
  const L = langs().list;
  if (!low) {
    const rec = recent.filter((c) => langs().byCode.has(c));
    return [...rec.map((c) => langs().byCode.get(c)), ...L.filter((l) => !rec.includes(l.code))];
  }
  const scored = [];
  const alias = ALIASES.get(low);
  for (const l of L) {
    const name = l.name.toLowerCase(), nat = l.native.toLowerCase(), code = l.code.toLowerCase();
    let s = 0;
    if (code === low || alias === l.code) s = 100;
    else if (name.startsWith(low) || nat.startsWith(low)) s = 80;
    else if (code.startsWith(low)) s = 60;
    else if (name.split(/[\s()]+/).some((w) => w.startsWith(low)) || nat.split(/[\s()]+/).some((w) => w.startsWith(low))) s = 50;
    else if (name.includes(low) || nat.includes(low)) s = 20;
    if (s) scored.push([s + (recent.includes(l.code) ? 5 : 0), l]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).map((x) => x[1]);
}
// "same language" ignores regions, except for Chinese scripts
function baseLang(code) {
  const c = ALIASES.get(String(code || "").toLowerCase()) || String(code || "");
  return /^zh/i.test(c) ? c : c.split("-")[0].toLowerCase();
}
function sameLang(a, b) {
  return !!a && !!b && baseLang(a) === baseLang(b);
}
// the Mac's language ("de-DE", "zh-Hans-CN", "pt-PT"…) as a Google code
function systemLangs() {
  const t = env("TR_TEST_SYSLANG", "");
  const list = t ? t.split(",") : $.NSLocale.preferredLanguages.js.map((s) => s.js);
  const out = [];
  for (const id of list) {
    let c = null;
    if (/^zh-(Hant|TW|HK|MO)/i.test(id)) c = "zh-TW";
    else if (/^zh/i.test(id)) c = "zh-CN";
    else if (/^pt-PT/i.test(id)) c = "pt-PT";
    else c = resolveLang(id.split(/[-_@]/)[0]);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
function configLang(name, fallback) {
  const v = env(name, fallback).trim();
  if (v === "none" || v === "") return null;
  if (v === "system") return systemLangs()[0] || "en";
  return resolveLang(v) || null;
}
// Language 2: the configured one when it differs from language 1; otherwise ("auto", or the same language
// as language 1) the Mac's next preferred language, then English (unless language 1 is English), then the
// last language picked with >xx. null when there is none: the text is already in the only language known.
function secondLang(primary) {
  const v = env("tr_language2", "auto").trim();
  if (v === "none") return null;
  const c = v === "auto" || v === "" ? null : configLang("tr_language2", "auto");
  if (c && !sameLang(c, primary)) return c;
  const sys = systemLangs().find((x) => !sameLang(x, primary));
  if (sys) return sys;
  if (!sameLang(primary, "en")) return "en";
  return rememberedTarget(primary);
}
const lastTargetPath = () => `${dataDir()}/last-target.json`;
// The last target picked with >xx (or used from the history) that isn't language 1
function rememberedTarget(primary) {
  const t = readJSON(lastTargetPath(), {}).code;
  if (typeof t === "string" && langs().byCode.has(t) && !sameLang(t, primary)) return t;
  return recentTargets().find((c) => !sameLang(c, primary)) || null;
}
function rememberTarget(code) {
  if (readJSON(lastTargetPath(), {}).code !== code) writeFile(lastTargetPath(), JSON.stringify({ code }));
}
// Quick picks when the text is already in the only known language: the Mac's other languages, then popular ones
function quickPicks(primary) {
  const out = [];
  for (const c of [...systemLangs(), ...recentTargets(), "es", "fr", "de", "zh-CN", "ja", "pt", "it"]) if (!sameLang(c, primary) && !out.includes(c)) out.push(c);
  return out.slice(0, 5);
}
function moreLangs() {
  return env("tr_more", "").split(/[,;\s]+/).map((s) => resolveLang(s)).filter(Boolean);
}

// ---------- HTTP (curl ships with macOS) ----------

// A curl config value: quoted, with backslashes and quotes escaped. Control characters are refused.
function cfg(s) {
  s = String(s);
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error("control character in request");
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Fetch several requests in parallel with one curl. The config (URLs, headers, API keys) goes to curl on
// stdin and request bodies through files, so neither text nor keys show up in the process list.
// Returns [{status, body, exit, error}] in order.
function httpMany(reqs) {
  if (!reqs.length) return [];
  const base = mkdirs(`${cacheDir()}/tmp`);
  const t = Date.now() / 1000;
  // Alfred kills a running Script Filter when the query changes: remove what such runs left behind
  for (const f of listDir(base)) if (t - mtime(`${base}/${f}`) > 120) removeFile(`${base}/${f}`);
  const dir = mkdirs(`${base}/${$.NSUUID.UUID.UUIDString.js}`);
  const lines = reqs.length > 1 ? ["parallel", "parallel-immediate", "parallel-max = 8"] : [];
  reqs.forEach((r, i) => {
    if (i) lines.push("next");
    lines.push(`url = ${cfg(r.url)}`, `output = ${cfg(`${dir}/${i}`)}`, "silent", "compressed",
      `max-time = ${r.timeout || TIMEOUT}`, `connect-timeout = ${Math.min(TIMEOUT, 5)}`, `user-agent = ${cfg(UA)}`,
      `proto = "=https,http"`, `write-out = ${cfg(`${i} %{http_code} %{exitcode} %{errormsg}\\n`)}`);
    if (r.body !== undefined) {
      writeFile(`${dir}/${i}.body`, r.body);
      lines.push(`data-binary = ${cfg(`@${dir}/${i}.body`)}`);
    }
    for (const [k, v] of Object.entries(r.headers || {})) lines.push(`header = ${cfg(`${k}: ${v}`)}`);
  });
  const res = exec("/usr/bin/curl", ["-K", "-"], lines.join("\n") + "\n");
  const meta = {};
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(\d+) (\d{3}) (\d+) ?(.*)$/);
    if (m) meta[m[1]] = { status: Number(m[2]), exit: Number(m[3]), error: m[4] };
  }
  const out = reqs.map((r, i) => {
    const m = meta[i] || { status: 0, exit: -1, error: res.stderr.trim() || "curl failed" };
    const body = readFile(`${dir}/${i}`);
    return Object.assign(m, { body: body === null ? "" : body, path: `${dir}/${i}` });
  });
  if (!reqs.some((r) => r.keep)) removeFile(dir);
  return out;
}

class TranslateError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // network | rate | auth | quota | nokey | unsupported | server | parse | request
    this.status = status || 0;
    this.until = 0; // rate limits: when to try again (epoch seconds)
  }
}
function httpError(r, service) {
  if (r.status === 0) {
    const why = { 6: "can’t find the server", 7: "can’t connect", 28: "timed out", 35: "secure connection failed", 60: "certificate problem" }[r.exit];
    return Object.assign(new TranslateError("network", why || "network error"), { timeout: r.exit === 28 });
  }
  if (r.status === 429) return new TranslateError("rate", "rate limited", 429);
  if (service === "deepl") {
    if (r.status === 403 || r.status === 401) return new TranslateError("auth", "API key rejected", r.status);
    if (r.status === 456) return new TranslateError("quota", "the monthly character limit is used up", 456);
    if (r.status === 413) return new TranslateError("request", "the text is too long", 413);
  }
  if (r.status === 403) return new TranslateError("rate", "the request was blocked", 403);
  if (r.status >= 500) return new TranslateError("server", "server error", r.status);
  if (r.status !== 200) {
    let msg = "";
    try {
      msg = String(own(JSON.parse(r.body), "message") || "");
    } catch (e) {}
    return new TranslateError("request", oneLine(msg, 80) || "request rejected", r.status);
  }
  return null;
}

// ---------- rate limits and back-off (shared by every process) ----------

// Takes n requests from the service's budget; false when that would exceed a limit.
function allowRequests(service, n) {
  if (env("TR_UNTHROTTLED", "") === "1") return true; // tests that make many requests on purpose
  const limits = LIMITS[service] || [[10, 10]];
  const dir = mkdirs(`${cacheDir()}/requests`);
  return withLock(`${dir}.lock`, () => {
    const t = Date.now();
    const log = [];
    const longest = Math.max(...limits.map((l) => l[1])) * 1000;
    for (const f of listDir(dir)) {
      const m = /^([a-z]+)-(\d+)-/.exec(f);
      const ts = m ? Number(m[2]) : 0;
      if (!m || ts < t - longest || ts > t + 60000) removeFile(`${dir}/${f}`);
      else if (m[1] === service) log.push(ts);
    }
    for (const [max, win] of limits) if (log.filter((x) => x > t - win * 1000).length + n > max) return false;
    for (let i = 0; i < n; i++) writeFile(`${dir}/${service}-${t}-${PID}-${i}`, "");
    return true;
  });
}
const backoffPath = (key) => `${cacheDir()}/backoff-${key}.json`;
// seconds left to wait before this service (or Google client) may be asked again, 0 when it may
function backoffLeft(key) {
  const b = readJSON(backoffPath(key), null);
  if (!b || typeof b.until !== "number") return 0;
  const left = b.until - now();
  return left > 0 && left < 7200 ? left : 0;
}
function backoffKind(key) {
  const b = readJSON(backoffPath(key), null);
  return b && backoffLeft(key) ? b.kind : null;
}
// After a 429 wait a minute, then twice as long each time it happens again (up to 15 minutes).
// After a timeout wait a few seconds, so each keystroke doesn't wait for another one (other network
// failures, like no connection or an unknown host, are quick and are simply tried again).
function noteResult(key, err) {
  const p = backoffPath(key);
  if (!err) {
    if (exists(p)) removeFile(p);
    return;
  }
  const prev = readJSON(p, {});
  if (err.kind === "rate") {
    const strikes = Math.min((Number(prev.strikes) || 0) + 1, 5);
    writeFile(p, JSON.stringify({ kind: "rate", strikes, until: now() + Math.min(900, 60 * 2 ** (strikes - 1)) }));
  } else if (err.kind === "network" && err.timeout) {
    writeFile(p, JSON.stringify({ kind: "network", strikes: Number(prev.strikes) || 0, until: now() + 8 }));
  }
}

// ---------- text splitting ----------

// Split text into pieces of at most `max` characters at paragraph, then sentence, then word boundaries.
// Each piece is {lead, text, trail}: the whitespace around a piece is kept and put back unchanged.
function splitText(text, max) {
  const pieces = [];
  const push = (s) => {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    if (m[2]) pieces.push({ lead: m[1], text: m[2], trail: m[3] });
    else if (pieces.length) pieces[pieces.length - 1].trail += s;
    else pieces.push({ lead: s, text: "", trail: "" });
  };
  const cut = (s, re) => {
    const parts = s.match(re) || [s];
    let cur = "";
    for (const part of parts) {
      if (cur.length + part.length <= max) {
        cur += part;
        continue;
      }
      if (cur) push(cur);
      cur = "";
      if (part.length <= max) cur = part;
      else if (re === PARA) cut(part, SENT);
      else if (re === SENT) cut(part, WORD);
      else for (let i = 0; i < part.length; ) {
        let end = Math.min(part.length, i + max);
        if (end < part.length && /[\uD800-\uDBFF]/.test(part.charAt(end - 1))) end--; // don't split a surrogate pair
        push(part.slice(i, end));
        i = end;
      }
    }
    if (cur) push(cur);
  };
  const PARA = /[^\n]*\n+|[^\n]+$/g, SENT = /[^.!?。！？;；]+[.!?。！？;；]*\s*|[.!?。！？;；]+\s*/g, WORD = /\S+\s*|\s+/g;
  if (text.length <= max) push(text);
  else cut(text, PARA);
  return pieces;
}

// ---------- Google Translate ----------

function googleRequest(text, sl, tl, client, details) {
  const dt = details ? ["t", "bd", "rm", "at", "md", "ex", "ss", "qca"] : ["t", "rm", "qca"];
  const url = `${GOOGLE_API}/translate_a/single?client=${client}&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&hl=en&ie=UTF-8&oe=UTF-8&${dt.map((d) => "dt=" + d).join("&")}`;
  return { url, body: "q=" + encodeURIComponent(text), headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } };
}
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");
// The response of translate_a/single: an array of arrays. Index 0: sentences [translation, original, …] and
// a last entry [null, null, target romanization, source romanization]; 1: dictionary by part of speech;
// 2: detected source; 5: alternatives; 7: spelling correction; 11: synonyms; 12: definitions; 13: examples.
function parseGoogle(body) {
  let d;
  try {
    d = JSON.parse(body.replace(/^\)\]\}'\s*/, ""));
  } catch (e) {
    throw new TranslateError(/<html|<!doctype/i.test(body) ? "rate" : "parse", /<html|<!doctype/i.test(body) ? "the request was blocked" : "unexpected answer");
  }
  if (!Array.isArray(d) || !Array.isArray(d[0])) throw new TranslateError("parse", "unexpected answer");
  let text = "", translit = "", srcTranslit = "";
  for (const s of d[0]) {
    if (!Array.isArray(s)) continue;
    if (typeof s[0] === "string") text += s[0];
    else if (s[0] == null && s.length >= 3) {
      translit += str(s[2]);
      srcTranslit += str(s[3]);
    }
  }
  const r = { text, src: str(d[2]) || str(arr(arr(d[8])[0])[0]), translit, srcTranslit, dict: [], alts: [], defs: [], syns: [], examples: [], correction: null };
  for (const e of arr(d[1])) {
    const entries = arr(e[2]).filter((x) => Array.isArray(x) && typeof x[0] === "string")
      .map((x) => ({ word: x[0], reverse: arr(x[1]).filter((y) => typeof y === "string"), score: Number(x[3]) || 0, article: str(x[4]) }));
    if (entries.length) r.dict.push({ pos: str(e[0]), entries });
  }
  const alts = arr(d[5]);
  if (alts.length === 1) for (const a of arr(arr(alts[0])[2])) if (typeof arr(a)[0] === "string" && a[0] !== text && !r.alts.includes(a[0])) r.alts.push(a[0]);
  const c = arr(d[7]);
  if (typeof c[1] === "string" && c[1]) r.correction = { text: c[1], auto: c[5] === true };
  for (const e of arr(d[11])) {
    const words = [];
    for (const g of arr(e[1])) for (const w of arr(arr(g)[0])) if (typeof w === "string" && !words.includes(w)) words.push(w);
    if (words.length) r.syns.push({ pos: str(e[0]), words });
  }
  for (const e of arr(d[12])) for (const x of arr(e[1])) if (typeof arr(x)[0] === "string") r.defs.push({ pos: str(e[0]), def: stripTags(x[0]), example: stripTags(x[2]) });
  for (const x of arr(arr(d[13])[0])) if (typeof arr(x)[0] === "string") r.examples.push(stripTags(x[0]));
  return r;
}

// ---------- DeepL ----------

// Target languages of the DeepL API (2025); a fresher list is fetched from /v2/languages and cached.
const DEEPL_TARGETS = ["AR", "BG", "CS", "DA", "DE", "EL", "EN-GB", "EN-US", "ES", "ES-419", "ET", "FI", "FR", "HE", "HU", "ID", "IT", "JA", "KO", "LT", "LV", "NB", "NL", "PL", "PT-BR", "PT-PT", "RO", "RU", "SK", "SL", "SV", "TH", "TR", "UK", "VI", "ZH", "ZH-HANS", "ZH-HANT"];
const deeplLangsPath = () => `${cacheDir()}/deepl-targets.json`;
function deeplTargets() {
  const c = readJSON(deeplLangsPath(), null);
  return c && Array.isArray(c.targets) && c.targets.length > 5 ? c.targets : DEEPL_TARGETS;
}
function deeplTargetsStale() {
  const c = readJSON(deeplLangsPath(), null);
  return !c || !(now() - (Number(c.at) || 0) < 7 * 86400);
}
// Google's code to DeepL's target code, or null when DeepL doesn't translate into it
function deeplTarget(code) {
  let t;
  if (code === "en") t = env("tr_deepl_english", "EN-US") === "EN-GB" ? "EN-GB" : "EN-US";
  else if (code === "pt") t = "PT-BR";
  else if (code === "pt-PT") t = "PT-PT";
  else if (code === "zh-CN") t = "ZH-HANS";
  else if (code === "zh-TW") t = "ZH-HANT";
  else if (code === "iw") t = "HE";
  else if (code === "no") t = "NB";
  else t = code.toUpperCase();
  const list = deeplTargets();
  return list.includes(t) ? t : null;
}
function deeplSource(code) {
  if (!code || code === "auto") return null;
  const b = baseLang(code);
  const t = b === "iw" ? "HE" : b === "no" ? "NB" : /^zh/.test(b) ? "ZH" : b.toUpperCase();
  return deeplTargets().some((x) => x.split("-")[0] === t) ? t : null;
}
function fromDeepl(code) {
  const c = String(code || "").toUpperCase();
  const m = { EN: "en", PT: "pt", ZH: "zh-CN", "ZH-HANS": "zh-CN", "ZH-HANT": "zh-TW", HE: "iw", NB: "no" };
  if (m[c]) return m[c];
  return resolveLang(c.toLowerCase()) || c.toLowerCase();
}
function deeplBase(key) {
  if (DEEPL_API) return trimSlash(DEEPL_API);
  return key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
}
function deeplRequest(key, text, sl, tl) {
  const body = { text: [text], target_lang: tl };
  const s = deeplSource(sl);
  if (s) body.source_lang = s;
  const f = env("tr_deepl_formality", "default");
  if (f === "prefer_more" || f === "prefer_less") body.formality = f;
  return { url: `${deeplBase(key)}/v2/translate`, body: JSON.stringify(body), headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" } };
}
function parseDeepl(body) {
  let d;
  try {
    d = JSON.parse(body);
  } catch (e) {
    throw new TranslateError("parse", "unexpected answer");
  }
  const t = arr(own(d, "translations"))[0];
  if (!t || typeof t.text !== "string") throw new TranslateError("parse", "unexpected answer");
  return { text: t.text, src: fromDeepl(t.detected_source_language), translit: "", srcTranslit: "", dict: [], alts: [], defs: [], syns: [], examples: [], correction: null };
}

// ---------- keychain (DeepL API key) ----------
// Security framework through the ObjC bridge, so the key never appears in a process's arguments.
// Dictionary keys are the string values of kSecClass ("class"), kSecAttrService ("svce") and so on.

const ERR_NOT_FOUND = -25300;
function testKeyPath() {
  const dir = env("TR_TEST_KEYCHAIN", ""); // test suite only: a folder standing in for the keychain
  return dir ? `${dir}/${BUNDLE}.deepl` : null;
}
function kcQuery() {
  const d = $.NSMutableDictionary.alloc.init;
  d.setObjectForKey($("genp"), $("class"));
  d.setObjectForKey($(BUNDLE), $("svce"));
  d.setObjectForKey($("deepl"), $("acct"));
  return d;
}
let KEY_CACHE;
function getKey() {
  if (KEY_CACHE !== undefined) return KEY_CACHE;
  const t = testKeyPath();
  if (t) return (KEY_CACHE = (readFile(t) || "").trim());
  const q = kcQuery();
  q.setObjectForKey($.NSNumber.numberWithBool(true), $("r_Data"));
  q.setObjectForKey($("m_LimitOne"), $("m_Limit"));
  const r = Ref();
  if ($.SecItemCopyMatching(q, r) !== 0 || !r[0]) return (KEY_CACHE = "");
  const s = $.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(r[0]), $.NSUTF8StringEncoding);
  return (KEY_CACHE = s.isNil() ? "" : s.js.trim());
}
function setKey(key) {
  KEY_CACHE = undefined;
  const t = testKeyPath();
  if (t) return writeFile(t, key);
  const data = $(key).dataUsingEncoding($.NSUTF8StringEncoding);
  const q = kcQuery();
  const upd = $.NSMutableDictionary.alloc.init;
  upd.setObjectForKey(data, $("v_Data"));
  let status = $.SecItemUpdate(q, upd);
  if (status === ERR_NOT_FOUND) {
    q.setObjectForKey(data, $("v_Data"));
    q.setObjectForKey($("DeepL API key (Alfred Translate)"), $("labl"));
    status = $.SecItemAdd(q, null);
  }
  return status === 0;
}
function deleteKey() {
  KEY_CACHE = undefined;
  const t = testKeyPath();
  if (t) {
    if (!exists(t)) return false;
    removeFile(t);
    return true;
  }
  return $.SecItemDelete(kcQuery()) === 0;
}
// DeepL keys are a UUID, with ":fx" for the free plan
function validKey(k) {
  return /^[A-Za-z0-9-]{20,60}(:fx)?$/.test(k);
}
function plausibleKey(k) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:fx)?$/i.test(k);
}

// ---------- clipboard ----------

// Plain text on the clipboard; "" when there is none, or when a password manager marked it as concealed
function clipboardText() {
  const t = env("TR_TEST_CLIPBOARD", null);
  if (t !== null) return t;
  const pb = $.NSPasteboard.generalPasteboard;
  const types = pb.types;
  if (!types.isNil() && types.containsObject($("org.nspasteboard.ConcealedType"))) return "";
  const s = pb.stringForType($.NSPasteboardTypeString);
  return s.isNil() ? "" : s.js;
}
function clearClipboardIf(text) {
  const t = env("TR_TEST_CLIPBOARD", null);
  if (t !== null) {
    const out = env("TR_TEST_CLIPBOARD_OUT", "");
    if (out && t.trim() === text) writeFile(out, "cleared");
    return;
  }
  if (clipboardText().trim() === text) $.NSPasteboard.generalPasteboard.clearContents;
}

// ---------- translation with cache ----------

const resultsDir = () => mkdirs(`${cacheDir()}/results`);
function cacheKey(provider, text, sl, tl, details) {
  const extra = provider === "deepl" ? `${env("tr_deepl_formality", "default")}|${deeplTarget(tl) || ""}` : details ? "d" : "";
  return `${provider}|${sl}|${tl}|${extra}|${text}`;
}
function readCached(key) {
  const p = `${resultsDir()}/${hash(key)}.json`;
  const c = readJSON(p, null);
  if (!c || c.key !== key || !c.result || typeof c.result.text !== "string") return null;
  const age = now() - (Number(c.at) || 0);
  return age >= -60 && age < STALE ? { result: c.result, age } : null;
}
function writeCached(key, result) {
  writeFile(`${resultsDir()}/${hash(key)}.json`, JSON.stringify({ key, at: now(), result }));
}
// Old translations: at most CACHE_FILES, none older than a month (checked once an hour)
function prune() {
  const marker = `${cacheDir()}/pruned`;
  if (now() - mtime(marker) < 3600 && exists(marker)) return;
  writeFile(marker, "");
  const dir = resultsDir();
  const files = listDir(dir).map((f) => ({ p: `${dir}/${f}`, t: mtime(`${dir}/${f}`) })).sort((a, b) => b.t - a.t);
  files.forEach((f, i) => {
    if (i >= CACHE_FILES || Date.now() / 1000 - f.t > STALE) removeFile(f.p);
  });
  for (const sub of ["out", "ql"]) {
    const d = `${cacheDir()}/${sub}`;
    for (const f of listDir(d)) if (Date.now() / 1000 - mtime(`${d}/${f}`) > 86400) removeFile(`${d}/${f}`);
  }
}

// Translate `text` into each target. Returns Map(target → {result, age} | {error, stale?}).
// Cached translations are used for a week without asking again; everything missing is fetched in one
// curl run (parallel). While offline or rate limited, a cached translation up to a month old is shown.
function translateMany(provider, text, sl, targets, opts = {}) {
  const details = provider === "google" && opts.details !== false;
  const out = new Map();
  const jobs = [];
  for (const tl of targets) {
    if (out.has(tl)) continue;
    const key = cacheKey(provider, text, sl, tl, details);
    const c = readCached(key);
    if (c && c.age < FRESH) out.set(tl, { result: c.result, age: c.age });
    else jobs.push({ tl, key, stale: c });
  }
  if (!jobs.length) return out;
  const fail = (job, err) => out.set(job.tl, job.stale ? { result: job.stale.result, age: job.stale.age, error: err, stale: true } : { error: err });

  if (provider === "deepl") {
    const key = getKey();
    const reqs = [];
    for (const job of jobs) {
      const tl = deeplTarget(job.tl);
      if (!key) fail(job, new TranslateError("nokey", "no API key"));
      else if (!tl) fail(job, new TranslateError("unsupported", `DeepL doesn’t translate into ${langName(job.tl)}`));
      else reqs.push({ job, req: deeplRequest(key, text, sl, tl) });
    }
    if (!reqs.length) return out;
    const wait = backoffLeft("deepl");
    if (wait) {
      const e = new TranslateError(backoffKind("deepl") || "rate", "waiting");
      e.until = now() + wait;
      reqs.forEach((x) => fail(x.job, e));
      return out;
    }
    if (!allowRequests("deepl", reqs.length)) {
      reqs.forEach((x) => fail(x.job, Object.assign(new TranslateError("rate", "slowing down"), { local: true, until: now() + 10 })));
      return out;
    }
    const all = reqs.map((x) => x.req);
    const langsReq = deeplTargetsStale() && !opts.noExtra;
    if (langsReq) all.push({ url: `${deeplBase(key)}/v2/languages?type=target`, headers: { Authorization: `DeepL-Auth-Key ${key}` } });
    const res = httpMany(all);
    let last = null;
    reqs.forEach((x, i) => {
      const r = res[i];
      let err = httpError(r, "deepl");
      if (!err) {
        try {
          const result = parseDeepl(r.body);
          writeCached(x.job.key, result);
          out.set(x.job.tl, { result, age: 0 });
          return;
        } catch (e) {
          err = e;
        }
      }
      last = err;
      fail(x.job, err);
    });
    noteResult("deepl", last && (last.kind === "rate" || last.kind === "network") ? last : null);
    if (langsReq) {
      const r = res[res.length - 1];
      try {
        const list = r.status === 200 ? JSON.parse(r.body) : null;
        const codes = Array.isArray(list) ? list.map((l) => String(own(l, "language") || "").toUpperCase()).filter((c) => /^[A-Z]{2,3}(-[A-Z0-9]{2,4})?$/.test(c)) : [];
        if (codes.length > 5) writeFile(deeplLangsPath(), JSON.stringify({ at: now(), targets: [...new Set(codes)] }));
      } catch (e) {}
    }
    return out;
  }

  // Google: long text is split into pieces sent in parallel and joined again
  const pieces = splitText(text, GOOGLE_CHUNK);
  const single = pieces.length === 1;
  let client = GOOGLE_CLIENTS.find((c) => !backoffLeft(`google-${c}`));
  const netWait = backoffKind("google") === "network" ? backoffLeft("google") : 0;
  if (!client || netWait) {
    const kind = netWait ? "network" : "rate";
    const e = new TranslateError(kind, kind === "network" ? "can’t connect" : "waiting");
    e.until = now() + (netWait || Math.min(...GOOGLE_CLIENTS.map((c) => backoffLeft(`google-${c}`))));
    jobs.forEach((j) => fail(j, e));
    return out;
  }
  let pending = jobs;
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const reqs = [];
    for (const job of pending) for (const p of pieces) reqs.push(googleRequest(p.text, sl, job.tl, client, details && single));
    if (!allowRequests("google", reqs.length)) {
      pending.forEach((j) => fail(j, Object.assign(new TranslateError("rate", "slowing down"), { local: true, until: now() + 10 })));
      return out;
    }
    const res = httpMany(reqs);
    const retry = [];
    let limited = null, netErr = null;
    pending.forEach((job, ji) => {
      const parts = [];
      let err = null;
      for (let pi = 0; pi < pieces.length && !err; pi++) {
        const r = res[ji * pieces.length + pi];
        err = httpError(r, "google");
        if (!err) {
          try {
            parts.push(parseGoogle(r.body));
          } catch (e) {
            err = e;
          }
        }
      }
      if (err) {
        if (err.kind === "rate") limited = err;
        if (err.kind === "network") netErr = err;
        if (err.kind === "rate" && attempt === 0) retry.push(job);
        else fail(job, err);
        return;
      }
      let result;
      if (single) result = parts[0];
      else {
        result = { text: "", src: parts[0].src, translit: "", srcTranslit: "", dict: [], alts: [], defs: [], syns: [], examples: [], correction: null };
        parts.forEach((p, i) => {
          const pc = pieces[i];
          result.text += pc.lead + p.text + pc.trail;
          if (p.translit) result.translit += (result.translit ? " " : "") + p.translit;
        });
      }
      writeCached(job.key, result);
      out.set(job.tl, { result, age: 0 });
    });
    noteResult(`google-${client}`, limited);
    noteResult("google", netErr);
    if (!retry.length) break;
    // rate limited: try the other client once, unless it is waiting too
    client = GOOGLE_CLIENTS.find((c) => !backoffLeft(`google-${c}`));
    if (!client) {
      const e = new TranslateError("rate", "rate limited", 429);
      e.until = now() + Math.min(...GOOGLE_CLIENTS.map((c) => backoffLeft(`google-${c}`)));
      retry.forEach((j) => fail(j, e));
      break;
    }
    pending = retry;
  }
  return out;
}

// ---------- history ----------

const historyPath = () => `${dataDir()}/history.json`;
function loadHistory() {
  const h = readJSON(historyPath(), {});
  return Array.isArray(h.entries) ? h.entries.filter((e) => e && typeof e.text === "string" && typeof e.result === "string") : [];
}
function saveHistory(entries) {
  return writeFile(historyPath(), JSON.stringify({ entries }));
}
function addHistory(entry) {
  const max = historyMax();
  if (!max || !entry.text || !entry.result) return;
  const cut = (s) => (s.length > HISTORY_TEXT_MAX ? s.slice(0, HISTORY_TEXT_MAX) : s);
  const e = { t: Math.round(now()), provider: entry.provider || "", src: entry.src || "", dst: entry.dst || "", text: cut(entry.text), result: cut(entry.result) };
  withLock(`${dataDir()}/history.lock`, () => {
    const list = loadHistory().filter((x) => !(x.text === e.text && x.dst === e.dst && x.result === e.result));
    list.unshift(e);
    saveHistory(list.slice(0, max));
  });
}
// A history entry's reference: its time, target and a hash of its text and translation
function histRef(e) {
  return `${e.t}|${e.dst}|${hash(e.text + "\u0000" + e.result)}`;
}
function touchHistory(ref) {
  if (!historyMax()) return;
  withLock(`${dataDir()}/history.lock`, () => {
    const list = loadHistory();
    const i = list.findIndex((e) => histRef(e) === ref);
    if (i < 1) return;
    const [e] = list.splice(i, 1);
    e.t = Math.round(now());
    list.unshift(e);
    saveHistory(list);
  });
}
function recentTargets() {
  const seen = [];
  for (const e of loadHistory()) if (e.dst && !seen.includes(e.dst)) seen.push(e.dst);
  return seen.slice(0, 5);
}

// ---------- Script Filter items ----------

function icon(name) {
  return { path: `icons/${name}.png` };
}
function info(title, subtitle, iconName = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: icon(iconName) }, extra);
}
// A row that runs an action (settings, key, open): modifiers are disabled so ⌘↩ doesn't paste the internal arg
function actionItem(title, subtitle, action, arg, iconName, extra = {}) {
  const off = { valid: false, arg: "", subtitle };
  return Object.assign({ title, subtitle, arg, variables: { tr_action: action }, icon: icon(iconName), mods: { cmd: off, alt: off, ctrl: off, shift: off } }, extra);
}
function fmtWait(sec) {
  if (!(sec > 60)) return "a minute";
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}
function fmtAgo(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function webURL(provider, text, sl, tl) {
  text = text.length > 5000 ? text.slice(0, 5000) : text;
  if (provider === "deepl") {
    const lc = (c) => (c && c !== "auto" ? baseLang(c).replace(/^iw$/, "he").replace(/^no$/, "nb").split("-")[0] : "auto");
    return `https://www.deepl.com/translator#${lc(sl)}/${lc(tl)}/${encodeURIComponent(text.replace(/\//g, "\\/"))}`;
  }
  return `https://translate.google.com/?sl=${encodeURIComponent(sl || "auto")}&tl=${encodeURIComponent(tl)}&text=${encodeURIComponent(text)}&op=translate`;
}
// Long results go to the action through a file in the cache (a Script Filter answer above ~50 KB is slow)
function inlineArg(text) {
  if (text.length <= INLINE_MAX) return text;
  const dir = mkdirs(`${cacheDir()}/out`);
  const p = `${dir}/result-${hash(text)}.txt`;
  writeFile(p, text);
  return `trfile:${p}`;
}
// A Quick Look (⌘Y) file for text that doesn't fit on one line: the translation, then the original
function quicklook(text, orig, sl, tl) {
  if (text.length < 70 && !/\n/.test(text)) return undefined;
  const dir = mkdirs(`${cacheDir()}/ql`);
  const p = `${dir}/${hash(`${tl}|${text}`)}.txt`;
  if (!exists(p)) writeFile(p, `${text}\n\n——— ${langName(sl)} → ${langName(tl)} ———\n\n${orig}\n`);
  return p;
}

// The rows for one translated text: ↩ copy, ⌘↩ paste, ⌥↩ open on the web, ⌃↩ speak, ⇧↩ translate back
function resultItem(title, subtitle, value, ctx, extra = {}) {
  const enterPastes = env("tr_enter", "copy") === "paste";
  const arg = inlineArg(value);
  const provider = ctx.provider;
  // history rows name their entry (tr_hist) instead of carrying the original text again
  const vars = ctx.hist ? { tr_hist: ctx.hist, tr_dst: ctx.speakLang || ctx.dst } : { tr_src: ctx.src || "", tr_dst: ctx.speakLang || ctx.dst, tr_provider: provider, tr_orig: ctx.orig.length > HISTORY_TEXT_MAX ? ctx.orig.slice(0, HISTORY_TEXT_MAX) : ctx.orig };
  const primary = enterPastes ? "paste" : "copy", other = enterPastes ? "copy" : "paste";
  const it = {
    title: oneLine(title, 250),
    subtitle,
    arg,
    icon: icon(extra.iconName || "translate"),
    variables: Object.assign({ tr_action: primary }, vars),
    text: { copy: value, largetype: value.length > 3000 ? value.slice(0, 3000) + "…" : value },
    mods: {
      cmd: { arg, subtitle: enterPastes ? "Copy to the clipboard" : "Paste into the frontmost app", variables: Object.assign({}, vars, { tr_action: other }) },
      alt: { arg: webURL(provider, ctx.orig, ctx.src, ctx.dst), subtitle: `Open in ${provider === "deepl" ? "DeepL" : "Google Translate"}`, variables: { tr_action: "open" } },
      ctrl: { arg, subtitle: `Speak (${langName(ctx.speakLang || ctx.dst)})`, variables: Object.assign({}, vars, { tr_action: "speak" }) },
      shift: ctx.swap === false || !ctx.src || ctx.src === "auto" || sameLang(ctx.src, ctx.dst)
        ? { valid: false, arg: "", subtitle: "Can’t swap: the source language is unknown" }
        : { arg: `${ctx.dst}>${ctx.src} ${value.length > 2000 ? value.slice(0, 2000) : value}`, subtitle: `Swap: translate this back into ${langName(ctx.src)}`, variables: { tr_action: "swap" } },
    },
  };
  const ql = extra.ql === false ? undefined : quicklook(value, ctx.orig, ctx.src, ctx.dst);
  if (ql) it.quicklookurl = ql;
  delete extra.iconName;
  delete extra.ql;
  return Object.assign(it, extra);
}

function errorItem(err, provider, sl, tl, text) {
  const name = NAMES[provider];
  const open = (title, sub, iconName) => actionItem(title, sub, "open", webURL(provider, text, sl, tl), iconName);
  switch (err.kind) {
    case "network":
      return info(`Couldn’t reach ${name}`, "Check your internet connection", "offline");
    case "rate":
      if (err.local) return info("Slowing down: too many translations in a few seconds", "Try again in a few seconds", "wait");
      return open(`${name} is limiting requests`, `Try again in ${fmtWait((err.until || now() + 60) - now())} · ↩ Open in ${provider === "deepl" ? "DeepL" : "Google Translate"}`, "wait");
    case "nokey":
      return info("Set your DeepL API key", `Save it via “${kwTranslate()} apikey” · or pick Google Translate in the Workflow’s Configuration`, "key", { autocomplete: "apikey " });
    case "auth":
      return info("DeepL rejected your API key", `Save a new one via “${kwTranslate()} apikey”`, "error", { autocomplete: "apikey " });
    case "quota":
      return actionItem("Couldn’t translate with DeepL: the monthly character limit is used up", "↩ Open your DeepL account", "open", "https://www.deepl.com/your-account/usage", "error");
    case "unsupported":
      return info(`Couldn’t translate with DeepL: ${err.message.replace(/^DeepL /, "it ")}`, "Pick Google Translate in the Workflow’s Configuration for this language", "error");
    default:
      return open(`Couldn’t get a translation from ${name}: ${oneLine(err.message, 60)}${err.status && err.kind !== "rate" ? ` (HTTP ${err.status})` : ""}`, `The service may have changed or be down · ↩ Open in ${provider === "deepl" ? "DeepL" : "Google Translate"}`, "error");
  }
}

// ---------- query parsing ----------

// A language token: "de", ">de", "en>de", "en>de,fr", "fr>" (source only), ">" (pick a language)
const SPEC_RE = /^([\p{L}\p{M}-]*)>([\p{L}\p{M},-]*)$/u;
function parseSpec(tok) {
  const m = SPEC_RE.exec(tok);
  if (!m) return null;
  const srcRaw = m[1], dstRaw = m[2];
  const src = srcRaw ? resolveLang(srcRaw, true) : "auto";
  const dstParts = dstRaw ? dstRaw.split(",") : [];
  const dsts = dstParts.map((d) => resolveLang(d));
  const ok = !!src && dsts.every(Boolean) && !(dstParts.length && dstParts[dstParts.length - 1] === "");
  return { tok, srcRaw, dstRaw, dstParts, src, dsts: dsts.filter(Boolean), ok };
}
// Returns {text, spec, pos: "start"|"end"|null, before}
function parseQuery(q) {
  const start = /^(\S*>\S*)(?:\s+([\s\S]*))?$/.exec(q);
  if (start) {
    const s = parseSpec(start[1]);
    if (s && (s.ok || !start[2])) return { text: (start[2] || "").trim(), spec: s, pos: start[2] ? "start" : "only", before: "" };
    if (s && (s.tok.startsWith(">") || s.src)) return { text: (start[2] || "").trim(), spec: s, pos: "start", before: "" };
  }
  const end = /^([\s\S]*?)\s+(\S*>\S*)$/.exec(q);
  if (end) {
    const s = parseSpec(end[2]);
    if (s && (s.ok || s.tok.startsWith(">") || s.src)) return { text: end[1].trim(), spec: s, pos: "end", before: end[1] };
  }
  return { text: q, spec: null, pos: null, before: "" };
}

// ---------- language picker ----------

function pickerItems(parsed) {
  const s = parsed.spec;
  // which part is being typed: the source (before ">"), or the last target
  const typingSrc = s.srcRaw && !s.src;
  const partial = typingSrc ? s.srcRaw : s.dstParts.length ? s.dstParts[s.dstParts.length - 1] : "";
  const recent = recentTargets();
  const found = searchLangs(partial, typingSrc ? [] : recent);
  if (typingSrc && "auto".startsWith(partial.toLowerCase())) found.unshift({ code: "auto", name: "Auto-detect", native: "" });
  const items = [];
  const textPart = parsed.pos === "start" ? parsed.text : parsed.before.trim();
  for (const l of found.slice(0, 40)) {
    let tok;
    if (typingSrc) tok = `${l.code}>${s.dstRaw}`;
    else tok = `${s.srcRaw}>${[...s.dstParts.slice(0, -1), l.code].filter(Boolean).join(",")}`;
    const ac = parsed.pos === "start" ? `${tok} ${textPart}` : textPart ? `${textPart} ${tok}` : `${tok} `;
    const what = typingSrc ? `Translate from ${l.name}` : `Translate into ${l.name}`;
    items.push(info(l.native ? `${l.name} · ${l.native}` : l.name, `${l.code} · ↩ ${what}${textPart ? "" : ", then type the text"}`, "language", { autocomplete: ac, valid: false }));
  }
  if (!items.length) items.push(info(`No language matches “${oneLine(partial, 40)}”`, "Type a language’s name or code, like >de or >german", "error"));
  return items;
}

// ---------- settings rows (`tra :…` and `tra apikey`) ----------

function maskKey(k) {
  return `••••${k.slice(-4)}`;
}
function saveKeyItem(source, key) {
  const masked = maskKey(key);
  const typed = source === "typed";
  const sub = typed ? `${masked} · Typed keys are briefly visible to other processes: the clipboard is safer` : `${masked} · Stored in your macOS Keychain`;
  return actionItem(typed ? "Save typed API key" : "Save API key from clipboard", sub, "savekey", "savekey", "key", {
    variables: { tr_action: "savekey", tr_key: key, tr_key_source: source },
    text: { copy: masked, largetype: masked },
  });
}
function usageItem(key) {
  // DeepL's usage endpoint, cached for 5 minutes
  const p = `${cacheDir()}/deepl-usage.json`;
  let u = readJSON(p, null);
  if (!u || u.key !== hash(key) || !(now() - u.at < 300)) {
    if (backoffLeft("deepl") || !allowRequests("deepl", 1)) return null;
    const r = httpMany([{ url: `${deeplBase(key)}/v2/usage`, headers: { Authorization: `DeepL-Auth-Key ${key}` }, timeout: 5 }])[0];
    const err = httpError(r, "deepl");
    if (err) return err.kind === "auth" ? info("DeepL rejected the saved API key", "Save a new one below or via the clipboard", "error") : null;
    try {
      const d = JSON.parse(r.body);
      u = { key: hash(key), at: now(), count: Number(d.character_count) || 0, limit: Number(d.character_limit) || 0 };
      writeFile(p, JSON.stringify(u));
    } catch (e) {
      return null;
    }
  }
  if (!u.limit) return null;
  const pct = Math.round((u.count / u.limit) * 100);
  return info(`DeepL usage: ${u.count.toLocaleString("en-US")} of ${u.limit.toLocaleString("en-US")} characters (${pct}%)`, `${key.endsWith(":fx") ? "DeepL API Free" : "DeepL API Pro"} · this billing period`, "info");
}
function keyItems(typed) {
  const items = [];
  const clip = clipboardText().trim();
  const saved = getKey();
  if (plausibleKey(clip) && clip !== saved) items.push(saveKeyItem("clipboard", clip));
  if (typed && typed !== clip) {
    if (validKey(typed)) items.push(saveKeyItem("typed", typed));
    else items.push(info("That doesn’t look like a DeepL API key", "Copy the key exactly as shown in your DeepL account", "error"));
  }
  if (saved) {
    const u = usageItem(saved);
    if (u) items.push(u);
    items.push(actionItem("Remove the saved API key", `${maskKey(saved)} · Deletes it from your macOS Keychain`, "delkey", "delkey", "key-remove"));
  }
  if (providerId() !== "deepl") items.push(actionItem("DeepL isn’t the provider yet", "↩ Pick DeepL in the Workflow’s Configuration", "config", "config", "settings"));
  items.push(actionItem("Get an API key…", "Opens DeepL’s API page (the free plan translates 500,000 characters a month) · Copy the key, then come back here", "open", "https://www.deepl.com/pro-api", "key-get"));
  return items;
}
function settingsItems(cmd, rest) {
  if (cmd === "key") return keyItems(rest);
  const count = loadHistory().length;
  const all = [
    info("apikey  DeepL API key", "Save or remove the key used when DeepL is the provider", "key", { autocomplete: "apikey ", match: "key" }),
    actionItem(":history  Recent translations", `Opens the “${kwHistory()}” keyword`, "search", `${kwHistory()} `, "history", { autocomplete: ":history", match: "history" }),
    actionItem(":clear  Clear the history", count ? `Deletes ${plural(count, "saved translation")}` : "The history is empty", "clearhistory", "clearhistory", "trash", { autocomplete: ":clear", match: "clear" }),
    actionItem(":cache  Clear cached translations", "Asks the service again for everything", "clearcache", "clearcache", "refresh", { autocomplete: ":cache", match: "cache" }),
    actionItem(":config  Open the Workflow’s Configuration", `Provider: ${NAMES[providerId()]} · languages, keywords, history and speech`, "config", "config", "settings", { autocomplete: ":config", match: "config" }),
  ];
  const hits = all.filter((i) => i.match.startsWith(cmd));
  for (const i of all) delete i.match;
  return hits.length ? hits : null;
}

// ---------- the `tra` Script Filter ----------

function homeItems() {
  const items = [info("Translate…", `Type text to translate · >de picks the language · ${kwTranslate()} : for settings`, "translate")];
  const max = historyMax();
  if (max) {
    const h = loadHistory().slice(0, 5);
    for (const e of h) {
      const ctx = { provider: e.provider === "deepl" ? "deepl" : "google", src: e.src, dst: e.dst, orig: e.text, hist: histRef(e) };
      items.push(resultItem(e.result, `${langName(e.src)} → ${langName(e.dst)} · ${oneLine(e.text, 80)}`, e.result, ctx, { iconName: "history" }));
    }
    if (h.length) items.push(actionItem("More recent translations…", `Search them via the “${kwHistory()}” keyword`, "search", `${kwHistory()} `, "history"));
  }
  return items;
}

function translateItems(text, spec, parsed, fromClipboard) {
  const items = [];
  let provider = providerId();
  let truncated = false;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    truncated = true;
  }
  const details = enabled("tr_details", true);
  const src = spec && spec.src ? spec.src : "auto";
  const explicit = !!(spec && spec.dsts.length);
  const primary = explicit ? spec.dsts[0] : configLang("tr_language1", "system") || "en";
  const secondary = explicit ? null : secondLang(primary);
  // a language picked with >xx becomes language 2 when language 1 has no partner (see secondLang)
  if (explicit && text && !sameLang(spec.dsts[0], configLang("tr_language1", "system") || "en")) rememberTarget(spec.dsts[0]);
  const extras = (explicit ? spec.dsts.slice(1) : moreLangs()).filter((c) => !sameLang(c, primary));
  let notice = null;

  let targets = [primary, ...extras];
  let res = translateMany(provider, text, src, targets, { details });
  // DeepL can't help (no key, rejected key, used-up quota, a language it lacks, rate limit): use Google instead
  const deeplFallback = (r) => provider === "deepl" && r && r.error && !r.stale && ["nokey", "auth", "quota", "unsupported", "rate"].includes(r.error.kind);
  if (deeplFallback(res.get(primary))) {
    notice = res.get(primary).error;
    provider = "google";
    res = translateMany(provider, text, src, targets, { details });
  } else if (provider === "deepl") {
    const miss = extras.filter((c) => deeplFallback(res.get(c)));
    if (miss.length) {
      const g = translateMany("google", text, src, miss, { details: false });
      for (const c of miss) if (g.get(c)) res.set(c, Object.assign({ provider: "google" }, g.get(c)));
    }
  }
  let main = res.get(primary), dst = primary, swapped = false;
  const detected = main && main.result ? main.result.src || src : src;
  // already in the target language: translate into the second language instead
  if (main && main.result && !explicit && sameLang(detected, primary) && secondary) {
    const sl2 = src === "auto" ? detected : src;
    let m2 = translateMany(provider, text, sl2, [secondary], { details, noExtra: true }).get(secondary);
    if (deeplFallback(m2)) {
      notice = m2.error;
      provider = "google";
      m2 = translateMany(provider, text, sl2, [secondary], { details }).get(secondary);
    }
    if (m2) {
      main = m2;
      dst = secondary;
      swapped = true;
    }
  }
  const fromLang = main && main.result ? main.result.src || src : src;
  const ctx = { provider, src: fromLang === "auto" ? "" : fromLang, dst, orig: text };
  const provName = provider === "deepl" ? "DeepL" : "Google";

  if (notice) {
    const why = { nokey: "no DeepL API key is saved", auth: "DeepL rejected your API key", quota: "DeepL’s monthly character limit is used up", unsupported: notice.message.replace(/^DeepL /, "DeepL "), rate: "DeepL is limiting requests" }[notice.kind];
    items.push(info(`Translated by Google: ${why}`, notice.kind === "nokey" || notice.kind === "auth" ? `Save a key via “${kwTranslate()} apikey”` : "DeepL is used again as soon as it can", notice.kind === "nokey" || notice.kind === "auth" ? "key" : "info", notice.kind === "nokey" || notice.kind === "auth" ? { autocomplete: "apikey " } : {}));
  }
  if (!main || !main.result) {
    items.push(errorItem(main ? main.error : new TranslateError("parse", "no answer"), provider, src, dst, text));
    return items;
  }
  const r = main.result;
  if (main.stale) items.unshift(info(`${main.error.kind === "network" ? "Offline" : main.error.local ? "Slowing down" : `${NAMES[provider]} is limiting requests`}: showing a translation from ${fmtAgo(main.age)}`, main.error.kind === "network" ? "Check your internet connection" : `Try again in ${fmtWait((main.error.until || now() + 60) - now())}`, main.error.kind === "network" ? "offline" : "wait"));

  // 1. the translation
  const already = sameLang(fromLang, dst) && fromLang !== "auto";
  const langs1 = `${langName(fromLang)} → ${langName(dst)}`;
  const clip = fromClipboard ? "Clipboard · " : "";
  items.push(resultItem(r.text || "(empty)", `${clip}${langs1}${swapped ? ` (already in ${langName(primary)})` : ""} · ${provName}`, r.text, ctx));
  // 2. spelling
  if (r.correction && r.correction.text && r.correction.text !== text) {
    const corrected = r.correction.text;
    const ac = parsed.pos === "start" ? `${parsed.spec.tok} ${corrected}` : parsed.pos === "end" ? `${corrected} ${parsed.spec.tok}` : corrected;
    items.push(info(r.correction.auto ? `Translated as “${oneLine(corrected, 120)}”` : `Did you mean “${oneLine(corrected, 120)}”?`, r.correction.auto ? "Google corrected the spelling · ↩ Use the corrected text" : "↩ Translate the corrected text", "spell", { autocomplete: ac }));
  }
  // 3. romanization of the translation
  if (r.translit && r.translit !== r.text) items.push(resultItem(r.translit, `Romanization (${langName(dst)} pronunciation)`, r.translit, Object.assign({}, ctx, { swap: false }), { iconName: "romanize" }));
  // 4. other target languages
  for (const c of extras) {
    if (c === dst || sameLang(c, fromLang)) continue;
    const x = res.get(c);
    const xp = (x && x.provider) || provider;
    const xctx = { provider: xp, src: ctx.src, dst: c, orig: text };
    if (x && x.result) items.push(resultItem(x.result.text, `${langName(c)}${x.result.translit && x.result.translit !== x.result.text ? ` · ${oneLine(x.result.translit, 80)}` : ""}${x.stale ? ` · from ${fmtAgo(x.age)}` : ""}${xp !== provider ? " · Google" : ""}`, x.result.text, xctx, { iconName: "language" }));
    else if (x && x.error) items.push(Object.assign(errorItem(x.error, xp, src, c, text), { title: `${langName(c)}: ${errorItem(x.error, xp, src, c, text).title}` }));
  }
  // 5. the languages, with a way to pick another one
  const textPart = parsed.pos === "start" ? parsed.text : parsed.pos === "end" ? parsed.before.trim() : fromClipboard ? "" : parsed.text;
  const pickAc = textPart ? `${textPart} >` : ">";
  if (already && !explicit && !secondary) {
    items.push(info(`Already in ${langName(dst)}: pick a language`, "↩ on a language below translates into it, and the next text goes there too · or set language 2 in the Workflow’s Configuration", "language", { autocomplete: pickAc }));
    for (const c of quickPicks(dst)) {
      const l = langs().byCode.get(c);
      items.push(info(`Translate into ${langName(c)}`, `${l && l.native ? `${l.native} · ` : ""}↩ or ⇥ adds >${c}`, "language", { autocomplete: `${textPart} >${c}`.trim() }));
    }
    items.push(info("Other language…", "Search every language", "language", { autocomplete: pickAc }));
  } else {
    const detail = r.srcTranslit && r.srcTranslit !== text ? ` · ${oneLine(r.srcTranslit, 90)}` : "";
    items.push(info(`${src === "auto" ? "Detected" : "From"}: ${langName(fromLang)} → ${langName(dst)}`, `↩ Pick another language${detail}`, "language", { autocomplete: pickAc }));
  }
  if (truncated) items.push(info(`Only the first ${MAX_CHARS.toLocaleString("en-US")} characters were translated`, "Translate longer text in parts, or on the web (⌥↩)", "info"));
  // 6. dictionary, alternatives, definitions, examples, synonyms (Google, single words and short phrases)
  if (details && provider === "google") {
    const dctx = Object.assign({}, ctx, { swap: false });
    let n = 0;
    for (const g of r.dict) {
      for (const e of g.entries.slice(0, 4)) {
        if (n++ >= 10) break;
        const art = e.article ? `${e.article} ` : "";
        items.push(resultItem(e.word, `${g.pos || "meaning"} · ${art}${e.word} · ${oneLine(e.reverse.slice(0, 5).join(", "), 100)}`, e.word, dctx, { iconName: "dictionary", ql: false }));
      }
    }
    // alternatives that only differ from a shown row by case or end punctuation are left out
    const norm = (x) => x.toLowerCase().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
    const shown = new Set([norm(r.text), ...r.dict.flatMap((g) => g.entries.slice(0, 4).map((e) => norm(e.word)))]);
    for (const a of r.alts.filter((x) => !shown.has(norm(x))).slice(0, 3)) items.push(resultItem(a, `Alternative translation · ${langName(dst)}`, a, dctx, { iconName: "alternative", ql: false }));
    const sctx = Object.assign({}, ctx, { speakLang: fromLang, swap: false });
    for (const d of r.defs.slice(0, 4)) items.push(resultItem(d.def, `Definition${d.pos ? ` (${d.pos})` : ""}${d.example ? ` · “${oneLine(d.example, 90)}”` : ""}`, d.def, sctx, { iconName: "definition", ql: false }));
    const exampleSet = new Set(r.defs.map((d) => d.example));
    for (const ex of r.examples.filter((e) => !exampleSet.has(e)).slice(0, 2)) items.push(resultItem(ex, `Example · ${langName(fromLang)}`, ex, sctx, { iconName: "example", ql: false }));
    for (const s of r.syns.slice(0, 2)) {
      const words = s.words.slice(0, 10).join(", ");
      items.push(resultItem(words, `Synonyms${s.pos ? ` (${s.pos})` : ""} · ${langName(fromLang)}`, words, sctx, { iconName: "synonyms", ql: false }));
    }
  }
  return items;
}

function filter(query) {
  prune();
  const q = query.replace(/\r\n?/g, "\n").trim();
  const ak = /^apikey(?:\s+([\s\S]*))?$/i.exec(q);
  if (ak) return { items: keyItems((ak[1] || "").trim()) };
  const sm = /^:([a-z]*)(?:\s+([\s\S]*))?$/i.exec(q);
  if (sm) {
    const rows = settingsItems(sm[1].toLowerCase(), (sm[2] || "").trim());
    if (rows) return { items: rows };
  }
  const parsed = parseQuery(q);
  if (parsed.spec && !parsed.spec.ok) {
    // a language token still being typed (or unknown): pick a language
    if (parsed.pos === "only" || parsed.pos === "end" || !parsed.text) return { items: pickerItems(parsed) };
    const bad = [parsed.spec.src ? null : parsed.spec.srcRaw, ...parsed.spec.dstParts.filter((d) => !resolveLang(d))].filter(Boolean)[0] || parsed.spec.tok;
    return { items: [info(`Unknown language “${oneLine(bad, 40)}”`, "Type a language’s name or code, like >de or >german", "error"), ...pickerItems(parsed).slice(0, 8)] };
  }
  // "text >", "text fr>" and a lone ">" or "fr>": pick the target language
  if (parsed.spec && (parsed.pos === "end" || parsed.pos === "only") && !parsed.spec.dstParts.length) return { items: pickerItems(parsed) };
  let text = parsed.text;
  let fromClipboard = false;
  if (!text && enabled("tr_clipboard", true)) {
    const clip = clipboardText().trim();
    if (clip) {
      text = clip;
      fromClipboard = true;
    }
  }
  if (!text) {
    if (parsed.spec) return { items: pickerItems(parsed) }; // ">jap": confirm the language, then type the text
    return { items: homeItems() };
  }
  return { items: translateItems(text, parsed.spec, parsed, fromClipboard) };
}

// ---------- the `trh` Script Filter ----------

function historyItems(query) {
  const max = historyMax();
  const all = loadHistory();
  if (!max) {
    const items = [actionItem("The history is off", "↩ Turn it on in the Workflow’s Configuration", "config", "config", "settings")];
    if (all.length) items.push(actionItem("Clear the history", `Deletes ${plural(all.length, "saved translation")} kept from before`, "clearhistory", "clearhistory", "trash"));
    return items;
  }
  if (!all.length) return [info("No translations yet", `Translations you copy, paste or speak via “${kwTranslate()}” show up here`, "history")];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = all.filter((e) => words.every((w) => e.text.toLowerCase().includes(w) || e.result.toLowerCase().includes(w) || langName(e.dst).toLowerCase().startsWith(w)));
  const items = hits.slice(0, 30).map((e, i) => {
    const ctx = { provider: e.provider === "deepl" ? "deepl" : "google", src: e.src, dst: e.dst, orig: e.text, hist: histRef(e) };
    const it = resultItem(e.result, `${langName(e.src)} → ${langName(e.dst)} · ${fmtAgo(now() - e.t)} · ${oneLine(e.text, 80)}`, e.result, ctx, { iconName: "history" });
    it.mods.shift = { arg: String(i), subtitle: "Remove from the history", variables: { tr_action: "forget", tr_hist: histRef(e) } };
    it.mods.alt = { arg: `${e.src || ""}>${e.dst} ${e.text.length > 2000 ? e.text.slice(0, 2000) : e.text}`, subtitle: `Translate again via “${kwTranslate()}”`, variables: { tr_action: "swap" } };
    return it;
  });
  if (!items.length) items.push(info("No matching translations", "Search the original text, the translation or a language", "history"));
  if (!words.length) items.push(actionItem("Clear the history", `Deletes ${plural(all.length, "saved translation")}`, "clearhistory", "clearhistory", "trash"));
  return items;
}

// ---------- speech ----------

const speakingPath = () => `${cacheDir()}/speaking.json`;
function processName(pid) {
  if (!alive(pid)) return "";
  return exec("/bin/ps", ["-p", String(pid), "-o", "comm="]).stdout.trim();
}
// Stop what's being read aloud; returns the hash of its text (or null)
function stopSpeaking() {
  const s = readJSON(speakingPath(), null);
  if (!s) return null;
  removeFile(speakingPath());
  const name = processName(Number(s.pid));
  if (/(^|\/)(say|afplay)$/.test(name)) {
    $.kill(Number(s.pid), 15);
    return s.text;
  }
  return null;
}
// Google's language code for a macOS voice (BCP 47)
function voiceLocale(code) {
  return { iw: "he", tl: "fil", jw: "jv", no: "nb", pt: "pt-BR", "zh-CN": "zh-CN", "zh-TW": "zh-TW", "mni-Mtei": "mni" }[code] || code;
}
function macVoice(code) {
  const t = env("TR_TEST_VOICES", null); // test suite only: {"de": "Anna"}
  if (t !== null) {
    try {
      return own(JSON.parse(t), code) || null;
    } catch (e) {
      return null;
    }
  }
  ObjC.import("AVFoundation");
  const v = $.AVSpeechSynthesisVoice.voiceWithLanguage(voiceLocale(code));
  return v.isNil() ? null : v.name.js;
}
// Pieces of at most 190 characters for Google's voice (it refuses longer text)
function speechPieces(text) {
  return splitText(text, 190).map((p) => p.text).filter(Boolean);
}
function speak(text, code) {
  text = text.trim();
  if (!text) return "Couldn’t speak: there is no text";
  const h = hash(`${code}|${text}`);
  if (stopSpeaking() === h) return undefined; // the same text again: ⌃↩ stops it
  const mode = env("tr_speech", "auto");
  const test = env("TR_TEST_NOOPEN", "") !== "";
  const dir = mkdirs(`${cacheDir()}/speech`);
  for (const f of listDir(dir)) if (Date.now() / 1000 - mtime(`${dir}/${f}`) > 600) removeFile(`${dir}/${f}`);
  const voice = mode === "google" ? null : macVoice(code);
  if (voice) {
    const file = `${dir}/${h}.txt`;
    writeFile(file, text);
    if (test) return `say -v ${voice} (${code})`;
    const pid = spawn("/usr/bin/say", ["-v", voice, "-f", file]);
    if (pid) writeFile(speakingPath(), JSON.stringify({ pid, text: h }));
    return pid ? undefined : "Couldn’t start speech";
  }
  if (mode === "macos") return `Couldn’t speak ${langName(code)}: no macOS voice is installed for it (add one in System Settings › Accessibility › Spoken Content)`;
  // Google's voice: download the pieces, join them (MP3 frames can be concatenated) and play
  if (backoffLeft("google-tts")) return "Couldn’t speak: Google Translate is limiting requests, try again in a minute";
  const pieces = speechPieces(text.length > MAX_SPEAK ? text.slice(0, MAX_SPEAK) : text);
  if (!allowRequests("tts", pieces.length)) return "Couldn’t speak: too many requests, try again in a moment";
  const reqs = pieces.map((p, i) => ({
    url: `${GOOGLE_API}/translate_tts?ie=UTF-8&client=gtx&tl=${encodeURIComponent(code)}&total=${pieces.length}&idx=${i}&textlen=${p.length}&q=${encodeURIComponent(p)}`,
    timeout: 10, keep: true,
  }));
  const res = httpMany(reqs);
  const bad = res.find((r) => r.status !== 200);
  if (bad) {
    const e = httpError(bad, "google") || new TranslateError("request", "no audio");
    noteResult("google-tts", e.kind === "rate" ? e : null);
    res.forEach((r) => removeFile(r.path.replace(/\/[^/]+$/, "")));
    return e.kind === "network" ? "Couldn’t reach Google Translate to speak the text" : `Couldn’t speak ${langName(code)}: ${e.kind === "rate" ? "Google Translate is limiting requests" : e.message}`;
  }
  const mp3 = `${dir}/${h}.mp3`;
  const data = $.NSMutableData.data;
  for (const r of res) {
    const d = $.NSData.dataWithContentsOfFile(r.path);
    if (!d.isNil()) data.appendData(d);
  }
  removeFile(res[0].path.replace(/\/[^/]+$/, ""));
  data.writeToFileAtomically(mp3, true);
  if (test) return `afplay ${pieces.length} (${code})`;
  const pid = spawn("/usr/bin/afplay", [mp3]);
  if (pid) writeFile(speakingPath(), JSON.stringify({ pid, text: h }));
  return pid ? undefined : "Couldn’t start speech";
}

// ---------- actions ----------

// Output for Alfred: {"alfredworkflow": …} sets tr_route, which the conditional after the action reads
// (copy → Copy to Clipboard, paste → Paste, anything else → Notification when there is text).
function route(routeName, arg) {
  return JSON.stringify({ alfredworkflow: { arg: arg || "", variables: { tr_route: routeName } } });
}
// "trfile:<cache>/out/result-<hash>.txt" (written by inlineArg) back to the text; nothing else is read
function resolveArg(arg) {
  const m = /^trfile:(.+)$/.exec(arg);
  if (!m) return arg;
  const dir = `${cacheDir()}/out/`;
  const p = m[1];
  if (p.startsWith(dir) && /^result-[0-9a-f]{16}\.txt$/.test(p.slice(dir.length))) {
    const t = readFile(p);
    if (t !== null) return t;
  }
  return arg;
}
function alfredSearch(query) {
  if (env("TR_TEST_NOOPEN", "") !== "") return `search ${query}`;
  exec("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application id "com.runningwithcrayons.Alfred" to search (item 1 of argv)', "-e", "end run", query]);
  return undefined;
}
function recordHistory(text) {
  const ref = env("tr_hist", "");
  if (ref) return touchHistory(ref); // a row from the history: move it to the top
  addHistory({ provider: env("tr_provider", ""), src: env("tr_src", ""), dst: env("tr_dst", ""), text: env("tr_orig", ""), result: text });
}

function act(arg) {
  const action = env("tr_action", "copy");
  const test = env("TR_TEST_NOOPEN", "") !== "";
  switch (action) {
    case "copy":
    case "paste": {
      const text = resolveArg(arg);
      recordHistory(text);
      return route(action, text);
    }
    case "speak": {
      const text = resolveArg(arg);
      const msg = speak(text, env("tr_dst", "en"));
      if (!msg || !/^Couldn’t/.test(msg)) recordHistory(text);
      return msg === undefined ? route("none", "") : route("notify", msg);
    }
    case "open": {
      if (!/^https:\/\/(translate\.google\.com|www\.deepl\.com)\//.test(arg)) return route("none", "");
      if (test) return route("notify", `open ${arg}`);
      const url = $.NSURL.URLWithString(arg);
      if (!url.isNil()) $.NSWorkspace.sharedWorkspace.openURL(url);
      return route("none", "");
    }
    case "swap":
      return route(test ? "notify" : "none", alfredSearch(`${kwTranslate()} ${arg}`) || "");
    case "search":
      return route(test ? "notify" : "none", alfredSearch(arg) || "");
    case "forget": {
      const ref = env("tr_hist", "");
      if (!ref) return route("notify", "Couldn’t remove the translation");
      const removed = withLock(`${dataDir()}/history.lock`, () => {
        const list = loadHistory();
        const next = list.filter((e) => histRef(e) !== ref);
        if (next.length === list.length) return false;
        return saveHistory(next);
      });
      if (removed && !test) alfredSearch(`${kwHistory()} `);
      return route("notify", removed ? (test ? "Removed from the history" : "") : "Couldn’t remove the translation");
    }
    case "clearhistory": {
      const n = loadHistory().length;
      withLock(`${dataDir()}/history.lock`, () => removeFile(historyPath()));
      return route("notify", n ? `Cleared ${plural(n, "translation")} from the history` : "The history was already empty");
    }
    case "clearcache": {
      for (const sub of ["results", "ql", "out", "speech", "tmp", "requests"]) removeFile(`${cacheDir()}/${sub}`);
      for (const f of listDir(cacheDir())) if (/^(backoff-.*|deepl-.*)\.json$/.test(f)) removeFile(`${cacheDir()}/${f}`);
      return route("notify", "Cleared cached translations");
    }
    case "savekey": {
      const key = env("tr_key", "").trim(); // from the Script Filter's variables, never argv
      if (!validKey(key)) return route("notify", "Couldn’t save the API key: it doesn’t look like a DeepL API key");
      if (!setKey(key)) return route("notify", "Couldn’t save the API key: the Keychain refused it");
      if (env("tr_key_source", "") === "clipboard") clearClipboardIf(key);
      for (const f of ["backoff-deepl.json", "deepl-usage.json", "deepl-targets.json"]) removeFile(`${cacheDir()}/${f}`);
      return route("notify", "API key saved");
    }
    case "delkey":
      if (!getKey()) return route("notify", "Couldn’t remove the API key: none is saved");
      if (!deleteKey()) return route("notify", "Couldn’t remove the API key: the Keychain refused it");
      removeFile(`${cacheDir()}/deepl-usage.json`);
      return route("notify", "API key removed");
    case "config":
      if (!test) exec("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application id "com.runningwithcrayons.Alfred" to reveal workflow (item 1 of argv)', "-e", "end run", BUNDLE]);
      return route(test ? "notify" : "none", test ? "config" : "");
  }
  return route("none", "");
}

// The Hotkey that replaces the selection: translate into the first language (or the second one when the
// text is already in the first), and paste over the selection
function instant(text) {
  text = text.replace(/\r\n?/g, "\n");
  const lead = /^\s*/.exec(text)[0], trail = /\s*$/.exec(text)[0];
  const body = text.trim();
  if (!body) return route("notify", "Couldn’t translate: select some text first");
  if (body.length > MAX_CHARS) return route("notify", `Couldn’t translate: the selection is longer than ${MAX_CHARS.toLocaleString("en-US")} characters`);
  let provider = providerId();
  const primary = configLang("tr_language1", "system") || "en";
  const secondary = secondLang(primary);
  let res = translateMany(provider, body, "auto", [primary], { details: false, noExtra: true }).get(primary);
  if (provider === "deepl" && res.error && !res.stale && ["nokey", "auth", "quota", "unsupported", "rate"].includes(res.error.kind)) {
    provider = "google";
    res = translateMany(provider, body, "auto", [primary], { details: false }).get(primary);
  }
  let dst = primary;
  if (res.result && sameLang(res.result.src, primary) && secondary) {
    res = translateMany(provider, body, res.result.src, [secondary], { details: false, noExtra: true }).get(secondary);
    dst = secondary;
  }
  if (!res.result) {
    const e = res.error || new TranslateError("parse", "no answer");
    const item = errorItem(e, provider, "auto", dst, body);
    return route("notify", item.title);
  }
  if (res.result.src && sameLang(res.result.src, dst)) return route("notify", `Couldn’t translate: the text is already in ${langName(dst)}`);
  addHistory({ provider, src: res.result.src, dst, text: body, result: res.result.text });
  return route("paste", lead + res.result.text + trail);
}

// Alfred rejects the whole JSON when a string holds an unpaired surrogate; bidi overrides and control
// characters are removed from display text (titles, subtitles). Args and copied text are kept exactly.
const EXACT = new Set(["arg", "copy", "largetype", "autocomplete", "tr_orig", "tr_key", "quicklookurl"]);
function wellFormed(k, v) {
  if (typeof v !== "string") return v;
  v = v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\ufffd"));
  if (EXACT.has(k)) return v.replace(/\x00/g, ""); // a NUL can't travel in Alfred's variables or argv
  return v.replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ");
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.length ? rest.join(" ") : env("tr_query", "");
  try {
    switch (cmd) {
      case "filter":
        return JSON.stringify({ skipknowledge: true, items: filter(query).items }, wellFormed);
      case "history":
        return JSON.stringify({ skipknowledge: true, items: historyItems(query.trim()) }, wellFormed);
      case "act":
        return act(rest.join(" "));
      case "instant":
        return instant(query);
    }
    return undefined;
  } catch (e) {
    if (cmd === "act" || cmd === "instant") return route("notify", `Couldn’t translate: ${oneLine(e.message, 150)}`);
    return JSON.stringify({ items: [info("Something went wrong", oneLine(e.message, 200), "error")] }, wellFormed);
  }
}
