# Translate — Plan

**Bundle ID:** `io.github.x-o-r-r-o.translate` · **Category:** Productivity · **Keywords:** `tra`, `trh`

## Why build it
Raycast’s “Google Translate” extension by gebeto has about 490,000 installs. Its features (2026-09): Translate, Translate Form, Quick Translate (several languages at once), language sets (favourite pairs) with automatic swap to the second language, Instant Translate (selection → copy, paste or HUD), Google TTS, “Open in Google Translate”, pronunciation text, and an HTTP proxy preference.

**Alfred today** (Gallery, GitHub, forum; 2026-09):
- “Translate” by meshchaninov: one target plus a secondary language, copy / paste / Text View. No dictionary, romanization, speech, history or language picker.
- “DeepL Translate” by alexanderwillner: `dl`, `dll` to change the target, fixed `dl-to-en` / `dl-to-de` keywords; without a key the query must end with a period. Copy and Large Type only.
- Polyglot (rsify): `trans text from x to y`, needs Node.js from npm; Alfred 3 era.
- Forum threads (“Google Translate (working) workflow requested”, “Google Translate (Languages Configurable)”): workflows broke when unofficial APIs changed (404s), people ask for DeepL instead of Google, and for workflows that don’t need Node, jq or nkf. alfredforum.com refused automated reading (HTTP 403), so this is from search summaries.

**Better than all of them:** no dependencies, Google (no key) or DeepL (key in the Keychain, automatic Google fallback), both directions from one keyword, several languages at once, inline language choice with a searchable picker, dictionary / alternatives / definitions / examples / synonyms / spelling correction / romanization, offline macOS voices with Google’s voice as a fallback, history, clipboard and selection, replace-selection Hotkey, and clear errors with cached results while offline or rate limited.

## Features (v1.0)
- [x] `tra <text>`: auto-detect, translate into language 1 (default: the Mac’s language); already in it → language 2 (Raycast’s language pairs)
- [x] Inline languages: `>fr`, `>fr,ja`, `en>de`, names in English or natively (`>german`, `>deutsch`), unique prefixes (`>ger`), aliases (`he`, `nb`, `zh-hant`…); `>` or `>ja…` opens a searchable picker (recent languages first); unknown languages get a clear row
- [x] “Also translate into” extra languages (fetched in parallel)
- [x] Rows: translation, spelling correction (“Did you mean…” / “Translated as…”), romanization, extra languages, detected language (with source pronunciation), dictionary by part of speech (with articles and reverse translations), alternatives, definitions with examples, examples, synonyms
- [x] ↩ copy, ⌘↩ paste (↩/⌘↩ can be swapped), ⌥↩ open in Google Translate / DeepL, ⌃↩ speak (again: stop), ⇧↩ swap (translate back), ⌘C, ⌘L, ⌘Y (Quick Look file with translation and original)
- [x] Empty query: translates the clipboard (not concealed/password items; can be turned off); otherwise shows recent translations
- [x] Universal Action “Translate Text” and a Hotkey on the selection; “Translate and Replace” Universal Action and Hotkey (paste over the selection)
- [x] History (`trh`): search, copy, paste, speak, translate again, remove one, clear; 100 / 500 / off
- [x] DeepL: API key via `tra apikey` / `tra :key` (Keychain, Security framework, clipboard cleared), usage row, Free/Pro host by `:fx`, formality, EN-US/EN-GB, PT-BR/PT-PT, ZH-HANS/ZH-HANT, target list from `/v2/languages` cached for a week; Google fallback with an explanatory row
- [x] Speech: macOS voice for the language (AVSpeechSynthesisVoice → `say -v`, offline), Google’s voice (`translate_tts`, pieces joined, `afplay`) when no voice is installed; configurable
- [x] Long text: split at paragraphs, sentences, then words into ≤ 4,500-character requests sent in parallel and joined with the original whitespace; cut at 30,000 characters with a notice; results over 5,000 characters reach the action through a cache file
- [x] Caching: identical requests (provider, languages, options, text) cached for a week, kept for a month to show while offline or rate limited; pruned hourly (1,000 files)
- [x] Rate limits across processes: a shared request log (Google 20/10 s and 150/min, DeepL 10/10 s and 60/min, speech 20/10 s); after a 429 the Google client is switched (`gtx` → `dict-chrome-ex`) and the limited one backs off 1, 2, 4… up to 15 min; an HTML “unusual traffic” page counts as a rate limit; a timeout pauses requests for 8 s
- [x] Script Filter `queuemode` 2 with automatic queue delay; atomic writes; locks tolerate a killed owner

## Tech
- **Stack:** JXA (`osascript -l JavaScript`) with the ObjC bridge (Foundation, AppKit, Security, AVFoundation), `/usr/bin/curl` (config and request bodies through stdin and files, never argv), `/usr/bin/say`, `/usr/bin/afplay`.
- **Endpoints:** `translate.googleapis.com/translate_a/single` (POST, `dt=t,bd,rm,at,md,ex,ss,qca`), `translate.googleapis.com/translate_tts`, `api-free.deepl.com` / `api.deepl.com` `/v2/translate`, `/v2/usage`, `/v2/languages`.
- **Response shape (Google):** index 0 sentences plus `[null, null, target romanization, source romanization]`; 1 dictionary; 2 detected language; 5 alternatives; 7 spelling correction (`[html, text, …, autoCorrected]`); 11 synonyms; 12 definitions; 13 examples.
- Apple’s Translation framework is Swift-only (no Objective-C API reachable from JXA) and would need compiled code, so it isn’t used.
- `tools/make_languages.js` builds `src/languages.json` (249 Google languages with their own names from NSLocale).

## Known limitations
- Google’s endpoint is unofficial and unauthenticated: Google can rate limit or change it. The workflow switches clients once, backs off and shows cached translations, but can’t guarantee answers.
- Every keystroke that pauses is a request (with Alfred’s automatic delay). With DeepL this uses the monthly character allowance; cached text doesn’t.
- The dictionary, alternatives, definitions and romanization exist only with Google.
- The macOS voice is the system’s default for the language (as `AVSpeechSynthesisVoice(language:)` picks it); enhanced/premium voices are used when they are that default.
- DeepL’s web link uses its `#src/dst/text` URL form; very long text is cut at 5,000 characters in web links.
- Cached translations and Quick Look files (which include the original text) stay in the workflow’s cache folder for up to a month (Quick Look files a day); `tra :cache` removes them. The history is in the workflow’s data folder.
- A DeepL key typed after `apikey` is passed to the Script Filter in the environment (not argv), but it is still briefly visible to processes of the same user; the clipboard is the safer way.

## Verify in real Alfred
- [ ] `tra` with a pause after typing: one request per pause (automatic queue delay + queuemode 2), no stale rows after fast typing.
- [ ] ⌘↩ pastes over the selection in the frontmost app (Hotkey and Universal Action flows too).
- [ ] “Translate and Replace” Hotkey and Universal Action paste the translation over the selection; errors appear as a notification.
- [ ] The conditional after the action routes `tr_route` copy / paste / message correctly (Run Script JSON `alfredworkflow.variables`).
- [ ] ⌃↩ speaks with the right voice (German, Japanese, Arabic), and ⌃↩ again stops; Google’s voice plays for a language without a macOS voice (e.g. Swahili).
- [ ] ⌘Y Quick Look shows the long-text file; ⌘L Large Type; ⌘C copies.
- [ ] ⇧↩ Swap reopens Alfred with `tra de>en …`; ⌥↩ in `trh` reopens `tra`.
- [ ] Picker: ↩ on a language row autocompletes and the translation follows.
- [ ] `tra apikey` with a real DeepL Free key: save from clipboard (clipboard cleared), usage row, translations, Remove.
- [ ] Empty query with a password manager item on the clipboard: not translated.
- [ ] Workflow Configuration: languages popups (long lists), “Also translate into”, ↩ action swap, history off, speech modes, DeepL formality/English.
- [ ] Hotkeys unset after import; notification wording.
- [ ] Screenshots for every `images/*.png` referenced in the README.

## Release checklist (Alfred forum + Gallery)
- [x] README starts with `## Usage`; each paragraph ends “via the `kw` keyword” / “via the Universal Action”
- [ ] A clean screenshot after each paragraph in `images/` (placeholders are in place)
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look as `<kbd>⌘</kbd><kbd>Y</kbd>`
- [x] No `## Setup` section (the DeepL key is optional and explained under Usage)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` is generated from README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never downloads or installs software; network calls only to Google Translate and DeepL
- [x] No compiled binaries; quarantine untouched
- [x] No hard-coded paths; `prefs.plist` is git-ignored; the API key lives only in the Keychain
- [x] AI assistance disclosed in the README
- [x] Version 1.0.0 in `workflow.json`; `python3 tools/build.py --package` builds `dist/alfred-translate-1.0.0.alfredworkflow`
- [ ] GitHub release with the `.alfredworkflow` attached (by the author)
- [ ] Forum post in “Share your Workflows” (by the author)

## Ideas for v1.1
1. DeepL glossaries (`/v3/glossaries`) picked per language pair.
2. A Text View (Alfred 5.5) for long translations, side by side with the original.
3. Google’s dictionary rows next to DeepL translations for single words (one extra request).
4. Language sets switchable with a keyword (saved outside the Workflow’s Configuration).
5. Detect and keep Markdown / code blocks untranslated.
