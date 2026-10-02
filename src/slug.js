'use strict';

const { GITHUB_SLUG_STRIP } = require('./github-slug-regex.js');

/**
 * mdcheck / slug.js
 *
 * Reproduces GitHub's heading-anchor (a.k.a. "slug") algorithm so that anchors
 * mdcheck validates are exactly the anchors GitHub will generate when the same
 * markdown is rendered on github.com.
 *
 * THE ALGORITHM, in order:
 *
 *   1. Inline formatting is removed first (see `stripInlineMarkup`): link
 *      syntax, code spans, emphasis markers, raw HTML tags and backslash
 *      escapes are dropped, because GitHub slugs the *rendered text*, not the
 *      raw source.
 *
 *   2. The text is lowercased (simple Unicode lowercase, not locale-aware).
 *
 *   3. Every character GitHub strips is deleted. That set comes from
 *      github-slugger (see `github-slug-regex.js`), NOT from a Unicode property
 *      class: GitHub removes numbers such as `½`, most symbol blocks and the
 *      astral planes wholesale, while `\p{N}` would keep them.
 *
 *   4. Every remaining *space* (U+0020 only) becomes one hyphen, so consecutive
 *      spaces produce consecutive hyphens. Tabs are not spaces: they are
 *      stripped in step 3, which is why `a\tb` and `ab` slug identically.
 *
 *   5. Nothing is trimmed. Leading and trailing hyphens are real output:
 *      `# --json` becomes `--json`, and a heading of only punctuation becomes
 *      the empty string. An earlier version of this file trimmed edge hyphens
 *      as a "friendlier" rule and that was simply wrong -- it turned valid
 *      links into reported failures.
 *
 *   6. Duplicate slugs get a numeric suffix in document order: the first
 *      "Usage" is "usage", the second "usage-1", the third "usage-2".
 *      De-duplication is a loop, not a counter, so a literal heading "Foo-1"
 *      appearing between two "Foo" headings is never handed out twice -- the
 *      second "Foo" skips past the taken "foo-1" and becomes "foo-2". This is a
 *      literal port of github-slugger, which is what GitHub uses.
 *
 * The empty string is a legitimate slug result. Anchors are compared
 * case-insensitively at check time, because some renderers lowercase and
 * percent-decode them.
 */

/**
 * Normalize a link-text or reference-id for *matching* purposes. CommonMark
 * label matching is case-insensitive and collapses internal whitespace.
 * @param {string} label
 * @returns {string}
 */
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Steps 2-5 of the algorithm: the slug for already-stripped heading text,
 * ignoring duplicates. Note what is NOT here: no trimming of edge hyphens, no
 * collapsing of runs of spaces, no special handling of tabs. Those are all
 * handled by the strip table itself, exactly as github-slugger does it.
 * @param {string} text heading text with inline markup already removed
 * @returns {string} slug, possibly empty
 */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(GITHUB_SLUG_STRIP, '')
    .replace(/ /g, '-');
}

/**
 * Step 1: remove inline markdown/HTML from heading source, approximating the
 * text a renderer would show.
 *
 * Two rules here are not obvious and both matter for anchor accuracy:
 *
 *   - GitHub slugs a heading's *text content*, so the contents of a code span
 *     or a link survive as plain text. ``Using `[code]` here`` slugs to
 *     "using-code-here", not to "using--here". Only the delimiters are
 *     removed, never the text between them.
 *   - Backslash-escaped punctuation is literal text, so it is protected from
 *     the markup strippers and restored afterwards. Otherwise `A \*b\* c`
 *     would lose its asterisks entirely instead of rendering them.
 *
 * @param {string} s
 * @returns {string}
 */
function stripInlineMarkup(s) {
  // Markdown constructs are stripped in the order a renderer would resolve
  // them, but two kinds of content are protected first because they are
  // *literal text* no matter what they look like:
  //
  //   - backslash escapes: "\*" is an asterisk, not emphasis
  //   - code span contents: "` <b> `" renders as "<b>" with no tag
  //
  // Both are swapped for private-use codepoints (U+E000, U+E001, ...)
  // before any markup stripper runs and restored afterwards. Those
  // codepoints cannot occur in real heading text, so nothing collides and
  // no markup delimiter can match them.
  /** @type {Map<number, string>} private-use codepoint -> literal text */
  const literal = new Map();
  let nextPoint = 0xe000;
  /** @param {string} text literal text to protect @returns {string} */
  const protect = (text) => {
    const point = nextPoint++;
    literal.set(point, text);
    return String.fromCodePoint(point);
  };

  let out = String(s).replace(/\\([\\`*_{}[\]()#+\-.!>~|"'])/g, (_m, ch) =>
    protect(ch)
  );

  // A code span opens on a run of N backticks and closes on the next run of
  // exactly N, so ``` `a`b` ``` is one span. A run with no matching closer
  // runs to the end of the text.
  out = out.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, text) => protect(text));

  // Images contribute only their alt text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Inline links contribute their text.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Reference-style links: [text][id], [text][] and shortcut [id].
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  // Raw HTML tags are markup, not text.
  out = out.replace(/<\/?[A-Za-z][^>]*>/g, '');

  // Strikethrough / strong / emphasis delimiters.
  //
  // An underscore is NOT an emphasis delimiter when it sits between two word
  // characters: CommonMark calls this the "intraword" rule, and it exists so
  // that identifiers like `snake_case` and `max_length` render literally instead
  // of turning into italics. GitHub follows it, so `# snake_case-kept` really
  // does slug to `snake_case-kept`. Deleting every `_` here is a false-positive
  // generator: it makes mdcheck reject a link that works on github.com.
  //
  // The lookarounds also skip protected private-use codepoints, which are not
  // word characters, so an escaped `\_` next to a word stays intact.
  out = out
    .replace(/\*\*/g, '')
    .replace(/(?<![A-Za-z0-9])__(?=\S)|(?<=\S)__(?![A-Za-z0-9])/g, '')
    .replace(/~~/g, '')
    .replace(/\*/g, '')
    .replace(/(?<![A-Za-z0-9])_(?=\S)|(?<=\S)_(?![A-Za-z0-9])/g, '');

  // Restore the protected literal text.
  if (literal.size > 0) {
    out = out.replace(/[\uE000-\uF8FF]/g, (ch) => {
      const text = literal.get(ch.codePointAt(0));
      return text === undefined ? ch : text;
    });
  }
  return out;
}

/**
 * Steps 1-5: turn the raw source of a heading into its slug.
 * @param {string} rawHeading source text between the leading #'s and the EOL
 * @returns {string}
 */
function slug(rawHeading) {
  return slugify(stripInlineMarkup(rawHeading));
}

/**
 * Tracks slugs for one document so duplicates can be numbered in document
 * order. Use one Slugger per file.
 *
 * Ported from github-slugger:
 *
 *     result = slug(value)
 *     while (occurrences has result) {
 *       occurrences[original]++
 *       result = original + '-' + occurrences[original]
 *     }
 *     occurrences[result] = 0
 */
class Slugger {
  constructor() {
    /** @type {Map<string, number>} slug -> times it has been handed out */
    this.occurrences = new Map();
  }

  /**
   * Reserve and return the unique slug for a heading.
   * @param {string} rawHeading heading source, inline markup included
   * @returns {string}
   */
  slug(rawHeading) {
    const original = slug(rawHeading);
    let result = original;
    while (this.occurrences.has(result)) {
      const next = (this.occurrences.get(original) ?? 0) + 1;
      this.occurrences.set(original, next);
      result = `${original}-${next}`;
    }
    this.occurrences.set(result, 0);
    return result;
  }

  /** @returns {string[]} every slug handed out so far, in document order */
  list() {
    return [...this.occurrences.keys()];
  }
}

module.exports = {
  slugify,
  slug,
  stripInlineMarkup,
  normalizeLabel,
  Slugger,
};
