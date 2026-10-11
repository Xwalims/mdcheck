'use strict';

const { GITHUB_SLUG_STRIP } = require('./github-slug-regex.js');
const { NAMED_ENTITIES } = require('./entities.js');

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
 * The CommonMark autolink body: a URI autolink is `<scheme:rest>` and an email
 * autolink is `<local@domain>`. Built from parts so the scheme and the local
 * part cannot contain characters that would let the pattern run past a `>`.
 *
 * Bounds and character classes are CommonMark's, not convenient ones:
 *   - scheme: `[A-Za-z][A-Za-z0-9+.-]{1,31}` -- 2 to 32 characters, which is
 *     why `<a:b>` is NOT an autolink but `<ab:c>` is.
 *   - rest: anything but `<`, `>` and whitespace, so `<https://a/ b>` is not an
 *     autolink and stays literal text.
 *   - email: CommonMark accepts `<a@b>` even though a bare domain has no dot,
 *     which the looser `[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+` used here would reject.
 *
 * @returns {RegExp} a global pattern; capture group 1 is a URI autolink's body
 *   and group 2 is an email autolink's body
 */
function autolinkSource() {
  // CommonMark's "absolute URI": scheme ":" rest, where rest excludes < > space.
  const uri = '<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\\s]*)>';
  // CommonMark's "email address": no angle-bracket-specials, at least one "@".
  const email =
    "<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>";
  // URI first: `mailto:a@b.co` has both a scheme and an "@", and it is a URI
  // autolink, so the branch order is what decides which body is captured.
  return new RegExp(`${uri}|${email}`, 'g');
}

/**
 * Replace entity references with the text they render as, protected as literal.
 *
 * CommonMark recognises the HTML5 named references (with the trailing
 * semicolon REQUIRED) and decimal/hexadecimal numeric references. A reference
 * CommonMark does not recognise is left exactly as written: `A &amp B` renders
 * with a literal `&amp`, so decoding it would invent an anchor.
 *
 * Out-of-range numeric references become U+FFFD, which is what the HTML5
 * parsing rules and CommonMark both specify for `&#0;`, values above
 * U+10FFFF, and surrogates.
 *
 * @param {string} s source with code spans and escapes already protected
 * @param {(text: string) => string} protect swap literal text out of harm's way
 * @returns {string}
 */
function decodeEntities(s, protect) {
  return s.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      // HTML5: 0, anything above U+10FFFF and surrogates are parse errors and
      // become U+FFFD. Number.isInteger also catches NaN from a malformed body.
      if (!Number.isInteger(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return protect('�');
      }
      return protect(String.fromCodePoint(cp));
    }
    const named = NAMED_ENTITIES.get(body);
    if (named === undefined) return m; // not an entity: leave the source alone
    return protect(named.map((cp) => String.fromCodePoint(cp)).join(''));
  });
}

/**
 * Raw inline HTML, as a CommonMark-compliant renderer matches it.
 *
 * This is the renderer's pattern (cmark-gfm's `html_inline`), not a hand-rolled
 * approximation, and the difference is not cosmetic. A "letter then anything
 * up to `>`" tag pattern deletes text the reader does see -- `<a.b>`, `<a=b>`,
 * `<a"b">` and `<a:b>` are all literal text in CommonMark, not tags. And the
 * comment sub-pattern has to encode HTML's real rule, which decides cases a
 * lazy `-->` search gets wrong in both directions: `<!-->`, `<!--->` and
 * `<!---->` ARE comments, while `<!----->`, `<!------>` and `<!-- -->` are not
 * the things a naive search would guess.
 *
 * The leading `^` of the original is dropped: mdcheck scans the whole heading,
 * so markup must be found at any offset, not only at the start of the string.
 */
const HTML_INLINE =
  /<[A-Za-z][A-Za-z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>`\x00-\x20]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\s\S]*?[?]>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>/g;

/**
 * CommonMark's code-span content rule (spec, "Code spans"): when the content
 * both begins AND ends with a space, and is not made up entirely of spaces, one
 * space is removed from each end. That is why ``` `` a ` b `` ``` renders as
 * `a ` b` and not ` a ` b `.
 *
 * Only U+0020 counts: a tab at either end is content, not the padding the rule
 * describes, so `` `\t a \t` `` keeps its tabs.
 *
 * @param {string} text raw content between the backtick runs
 * @returns {string} the text the reader sees
 */
function codeSpanContent(text) {
  if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) {
    return text.slice(1, -1);
  }
  return text;
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
  // them, but three kinds of content are protected first because they are
  // *literal text* no matter what they look like:
  //
  //   - backslash escapes: "\*" is an asterisk, not emphasis
  //   - code span contents: "` <b> `" renders as "<b>" with no tag
  //   - decoded entity references: "&lt;b&gt;" renders as the TEXT "<b>", and
  //     that text is not a tag. Protecting the decoded character is what stops
  //     the HTML-tag stripper from eating an entity-produced tag (below).
  //
  // All are swapped for private-use codepoints (U+E000, U+E001, ...) before any
  // markup stripper runs and restored afterwards. Those codepoints cannot occur
  // in real heading text, so nothing collides and no markup delimiter can match
  // them.
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
  out = out.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, text) => protect(codeSpanContent(text)));

  // Entity references are decoded BEFORE the tag/autolink strippers run, and the
  // decoded character is protected rather than written out. Two consequences,
  // both required by CommonMark and both previously wrong here:
  //
  //   - `A &amp; B` renders as `A & B`, so the slug is `a--b`. Left as source it
  //     slugged to `a-amp-b`, i.e. mdcheck reported a working `#a--b` anchor as
  //     dangling and would have pointed a reader at `#a-amp-b` instead.
  //   - `&lt;b&gt;x&lt;/b&gt;` renders as the TEXT `<b>x</b>`. Decoding it into the
  //     string first would hand the tag stripper a real `<b>` and it would then
  //     delete the text the reader sees. Protecting it keeps it as literal text.
  out = decodeEntities(out, protect);

  // Autolinks contribute their own text: `<https://example.com>` renders as the
  // URL. Previously the HTML-tag regex below matched the whole `<...>` and
  // deleted it, so a heading built around an autolink lost its anchor text
  // entirely -- `auto <https://x.io>` slugged to `auto-` where GitHub emits
  // `auto-httpsxio`. Done after entity decoding and before the tag stripper,
  // matching render order: a `&lt;`-escaped `<` is already protected text by
  // now and is correctly NOT treated as an autolink delimiter.
  out = out.replace(autolinkSource(), (_m, uriBody, emailBody) =>
    protect(uriBody === undefined ? emailBody : uriBody)
  );

  // Images contribute only their alt text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Inline links contribute their text.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Reference-style links: [text][id], [text][] and shortcut [id].
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  // Raw inline HTML -- tags, comments, processing instructions, declarations
  // and CDATA -- is markup, not text. Done after entities and autolinks so the
  // `<` of a real autolink has already been claimed and an entity-produced
  // `<` is already protected text, and done before the emphasis strippers so a
  // delimiter inside an attribute value is never treated as one.
  out = out.replace(HTML_INLINE, '');

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
