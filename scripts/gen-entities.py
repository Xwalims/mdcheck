#!/usr/bin/env python3
"""Regenerate src/entities.js: the HTML5 named character references CommonMark
recognises in a heading.

    python3 scripts/gen-entities.py && git diff --exit-code src/entities.js

The table comes from Python's own `html.entities.html5` -- the HTML5 standard's
named character reference list, which is exactly what CommonMark defers to --
and never from a runtime renderer, for the same reason github-slug-regex.js is
vendored rather than derived: a hand-rolled approximation of a standard's table
drifts from real renderers in exactly the places users notice.

Only entries ending in ';' are emitted. CommonMark requires the semicolon, and
HTML5's legacy semicolonless forms are not recognised by CommonMark at all.
"""
import html.entities
import pathlib
import sys

HEADER = """\
'use strict';

// mdcheck / entities.js
//
// The HTML5 named character references CommonMark recognises in a heading,
// keyed by name WITHOUT the trailing semicolon.
//
// CommonMark does not define this list itself: its spec points at the HTML5
// named character references, so this IS the standard's table rather than an
// approximation. It is vendored for the same reason github-slug-regex.js is:
// an anchor mdcheck accepts must be the anchor github.com emits, and a hand-
// typed subset drifts from the renderer exactly where people notice.
//
// Only entries ending in ';' are listed. CommonMark requires the semicolon --
// 'A &amp B' renders with a literal '&amp', it is not an entity -- and HTML5
// also defines legacy semicolonless forms that CommonMark does NOT recognise,
// so including them would invent anchors that do not exist.
//
// Regenerate with `python3 scripts/gen-entities.py`.

/**
 * name (no semicolon) -> the character(s) it expands to.
 * @type {Map<string, string[]>}
 */
const NAMED_ENTITIES = new Map([
"""


def main() -> int:
    names = sorted({k for k in html.entities.html5 if k.endswith(";")})
    rows = []
    for name in names:
        key = name[:-1]
        value = html.entities.html5[name]
        # Emit code points so legacy multi-character expansions stay readable
        # and the file stays diffable.
        cps = ", ".join(f"0x{ord(c):X}" for c in value)
        rows.append(f"  ['{key}', [{cps}]],")

    out = HEADER + "\n".join(rows) + "\n]);\n\nmodule.exports = { NAMED_ENTITIES };\n"
    path = pathlib.Path(__file__).resolve().parent.parent / "src" / "entities.js"
    path.write_text(out, encoding="utf-8")
    print(f"wrote {path} ({len(names)} named references)")
    return 0


if __name__ == "__main__":
    sys.exit(main())