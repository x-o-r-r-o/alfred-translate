#!/usr/bin/osascript -l JavaScript
// Developer tool: writes src/languages.json from tools/google_languages.json (the languages Google
// Translate supports, [code, English name]) and adds each language's own name from macOS (NSLocale).
//   osascript -l JavaScript tools/make_languages.js tools/google_languages.json src/languages.json
ObjC.import("Foundation");
const LOCALE_CODE = { iw: "he", jw: "jv", tl: "fil", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant", "mni-Mtei": "mni", "pt-PT": "pt-PT", pt: "pt-BR" };
function run(argv) {
  const [src, out] = argv;
  const list = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(src, $.NSUTF8StringEncoding, $()).js);
  const rows = list.map(([code, name]) => {
    const id = LOCALE_CODE[code] || code;
    const loc = $.NSLocale.localeWithLocaleIdentifier(id);
    let native = loc.localizedStringForLocaleIdentifier(id);
    native = native.isNil() ? "" : native.js;
    if (native === id || native.toLowerCase() === name.toLowerCase()) native = "";
    if (native) native = native.charAt(0).toLocaleUpperCase() + native.slice(1);
    return [code, name, native];
  });
  const text = "[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n";
  $(text).writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, $());
  return `Wrote ${rows.length} languages to ${out}`;
}
