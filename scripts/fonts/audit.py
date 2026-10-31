#!/usr/bin/env python3
"""Records static font usage and inventories specialized fonts without changing them."""

import html
import json
import re
import urllib.request
from pathlib import Path

from subset import HERE, ROOT, inventory, ranges

pattern = re.compile(r"font-(?:family|weight|style|variation|feature|optical|variant)|font(?:Family|Weight|Style|VariationSettings|FeatureSettings|OpticalSizing|Variant)|\bfont\s*:|font-\[|hyphens|\b(?:tabular-nums|italic|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black))\b")
records = []
characters = set()
for path in sorted((ROOT / "web/src").rglob("*")):
    if path.suffix not in (".svelte", ".css", ".ts", ".html") or any(part in path.parts for part in ("__tests__", "paraglide")) or path.name == "font-faces.css":
        continue
    content = path.read_text()
    characters.update(map(ord, html.unescape(content)))
    for line, text in enumerate(content.splitlines(), 1):
        if pattern.search(text):
            records.append({"file": str(path.relative_to(ROOT)), "line": line, "text": text.strip()})
messages = json.loads((ROOT / "web/messages/en.json").read_text())
content_characters = {ord(char) for value in messages.values() if isinstance(value, str) for char in value}
report = {
    "scope": "Source superset includes inline Svelte directives, component styles, domain/editor/terminal styles and English messages. Runtime chat, files and terminal content are unbounded; all existing font character coverage is preserved.",
    "sourceCharacters": ranges(characters),
    "messageCharacters": ranges(content_characters),
    "requiredCoverage": "Existing cmap union, including Latin-1 and Latin Extended-A wherever the source contains them; no new glyphs or CJK coverage are introduced.",
    "cssGeneratedCharacters": ["U+2010 (hyphens:auto, reserved even though the current source has no such declaration)", "U+2018-U+2019 and U+201C-U+201D (prose quotation marks)"],
    "declarations": records,
}
(HERE / "usage.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

specialized = []
for path in sorted((ROOT / "web/node_modules/katex/dist/fonts").glob("*.woff2")):
    specialized.append({"role": "KaTeX math", **inventory(path)})
commit = "f31794b6e9e65698a062262e2f826f679dcb7070"
for weight in ("Regular", "Bold"):
    name = f"MonaspaceNeonNF-{weight}.woff2"
    url = f"https://cdn.jsdelivr.net/gh/githubnext/monaspace@{commit}/fonts/Web%20Fonts/NerdFonts%20Web%20Fonts/Monaspace%20Neon/{name}"
    path = HERE / "sources" / name
    if not path.exists():
        with urllib.request.urlopen(url) as response:
            path.write_bytes(response.read())
    specialized.append({"role": "Default terminal and private-use fallback", "url": url, **inventory(path)})
(HERE / "inventory-specialized.json").write_text(json.dumps(specialized, indent=2) + "\n")
print(f"Audited {len(records)} declarations and {len(specialized)} specialized font files.")
