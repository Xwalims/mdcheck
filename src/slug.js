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
 * @param {(text: string, opener: string) => string} protect swap literal text
 *   out of harm's way, remembering the source character it opened with
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
        return protect('�', '&');
      }
      return protect(String.fromCodePoint(cp), '&');
    }
    const named = NAMED_ENTITIES.get(body);
    if (named === undefined) return m; // not an entity: leave the source alone
    return protect(named.map((cp) => String.fromCodePoint(cp)).join(''), '&');
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

/* ------------------------------------------------------------------ *
 * Emphasis and strikethrough.
 *
 * These are resolved with CommonMark's real delimiter algorithm rather than
 * with regexes, and the difference is not academic. An earlier version deleted
 * a `_` with `(?<![A-Za-z0-9])_(?=\S)|(?<=\S)_(?![A-Za-z0-9])`, which looks
 * like it encodes the intraword rule but does not: it has no notion of which
 * side of a run a delimiter sits on, so it deleted the leading underscore of
 * `_a`, `# _a` slugged to `a` where GitHub emits `_a`, and mdcheck reported a
 * working anchor as dangling. Because github-slugger's strip table KEEPS `_`
 * (while it drops `*` and `~`), an underscore is the only emphasis delimiter
 * whose mishandling can move an anchor -- which is exactly why this is here
 * and why `*` cannot be allowed to silently break in exchange.
 *
 * The rules implemented are CommonMark's, in the spec's order:
 *   - flanking: a run is left- / right-flanking per the whitespace and
 *     punctuation tests, and `_` additionally cannot both open and close
 *     inside a word;
 *   - the "rule of three" on run lengths when a delimiter can both open and
 *     close;
 *   - matching the first closer against the nearest opener, deleting every
 *     delimiter between them, and retrying the same closer while it has
 *     characters left;
 *   - an unmatched closer stays in the stack as a potential opener unless it
 *     cannot open at all.
 * ------------------------------------------------------------------ */

/** @enum {number} */
const CLASS_WHITESPACE = 0;
const CLASS_PUNCTUATION = 1;
const CLASS_OTHER = 2;

/** CommonMark's "whitespace character": Zs plus tab, LF, FF and CR. */
const WHITESPACE_RE = /[\p{Zs}\t\n\f\r]/u;
/** CommonMark's "punctuation character": the Unicode P and S categories. */
const PUNCTUATION_RE = /[\p{P}\p{S}]/u;

/**
 * @param {string} char one character, or undefined for the end of the line
 * @returns {number} one of the CLASS_* constants
 */
function classify(char) {
  // The beginning and end of a line count as whitespace, which is what makes a
  // run at either edge of a heading behave the way the spec describes.
  if (char === undefined) return CLASS_WHITESPACE;
  if (WHITESPACE_RE.test(char)) return CLASS_WHITESPACE;
  if (PUNCTUATION_RE.test(char)) return CLASS_PUNCTUATION;
  return CLASS_OTHER;
}

/**
 * The SOURCE character that occupies `index` in the original heading.
 *
 * For protected text this is the first character of the source span that was
 * swapped out -- a backtick for a code span, a backslash for an escape, `&` for
 * an entity, `<` for an autolink, `[` for a link -- and NOT the first character
 * of the text that span renders as. A renderer decides flanking from the raw
 * source: in `` `a`* `` the `*` is preceded by a BACKTICK, which is punctuation,
 * so the run cannot open. Reading it as `a`, which is a word character, let it
 * open and deleted an asterisk the reader can see.
 *
 * @param {string} text
 * @param {number} index
 * @param {Map<number, string>} source protected codepoint -> the source
 *   character its span opened with
 * @returns {string|undefined} undefined when index is out of range
 */
function sourceCharAt(text, index, source) {
  const point = text.codePointAt(index);
  if (point === undefined) return undefined;
  const opener = source.get(point);
  return opener ?? String.fromCodePoint(point);
}

/**
 * The index at which the character ending at `index` starts. Astral
 * characters are two UTF-16 units, so stepping back one from a low surrogate
 * would classify half a character and get the flanking test wrong.
 * @param {string} text
 * @param {number} index
 * @returns {number} -1 when there is no preceding character
 */
function previousCharStart(text, index) {
  let start = index - 1;
  if (start < 0) return -1;
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start -= 1;
  return start;
}

const DELIMITER_CHARS = new Set(['*', '_', '~']);

/**
 * One delimiter CHARACTER on the stack. A run of three `_` pushes three of
 * these, each carrying the run's length: cmark works per character, and the
 * per-run model this file used to have is not equivalent.
 * @typedef {object} Delim
 * @property {string} char
 * @property {number} offset position of this character in the text
 * @property {number} span how many characters of the source this delimiter is
 *   markup for: 1 for `*` and `_`, 2 for a `~~` strikethrough pair
 * @property {number} length length of the RUN it came from, never decremented
 * @property {boolean} canOpen cleared once this delimiter is used as a closer
 * @property {boolean} canClose cleared once this delimiter is used as an opener
 * @property {number} end index of the matching closer, -1 while unmatched
 */

/**
 * Decide whether a run can open and/or close emphasis.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {string} char
 * @param {Map<number, string>} source protected codepoint -> source opener
 * @returns {{canOpen: boolean, canClose: boolean}}
 */
function flanking(text, start, end, char, source) {
  const prevStart = previousCharStart(text, start);
  const before = classify(prevStart < 0 ? undefined : sourceCharAt(text, prevStart, source));
  const after = classify(sourceCharAt(text, end, source));

  // Left-flanking: not followed by whitespace, and either not followed by
  // punctuation or preceded by whitespace/punctuation. Right-flanking is the
  // mirror image. A run at the very start is treated as preceded by
  // whitespace, which classify() returns for undefined.
  const leftFlanking = after !== CLASS_WHITESPACE &&
    (after !== CLASS_PUNCTUATION || before === CLASS_WHITESPACE || before === CLASS_PUNCTUATION);
  const rightFlanking = before !== CLASS_WHITESPACE &&
    (before !== CLASS_PUNCTUATION || after === CLASS_WHITESPACE || after === CLASS_PUNCTUATION);

  if (char === '_') {
    // The intraword rule, which is what keeps `snake_case` literal.
    return {
      canOpen: leftFlanking && (!rightFlanking || before === CLASS_PUNCTUATION),
      canClose: rightFlanking && (!leftFlanking || after === CLASS_PUNCTUATION),
    };
  }
  // `*` and GFM's `~` have no intraword restriction.
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

/**
 * Remove the delimiters that CommonMark would resolve as emphasis, strong or
 * strikethrough, leaving the ones that render as literal characters.
 *
 * This is a port of cmark's `process_emphasis` (see
 * markdown-it-py's rules_inline/balance_pairs.py, which follows the same
 * algorithm), and it follows it in a detail that is easy to get wrong: the
 * delimiter stack holds ONE ENTRY PER CHARACTER, and each entry's `length` is
 * the length of the whole run it came from and NEVER CHANGES. An earlier
 * version here kept one entry per run and decremented `remaining` as
 * delimiters were consumed -- which sounds equivalent and is not. "Rule of
 * three" is defined on the original run lengths, and once a run has been
 * partially consumed the two definitions disagree, which is what produced
 * `!**!__!_a__` rendering as `!**!__!a_` instead of `!**!_!a`.
 *
 * `openersBottom` and the `jumps` table are carried over for the same reason
 * cmark has them: without them the scan is quadratic on `*a *a *a *a`.
 *
 * @param {string} text markup-stripped heading text, private-use placeholders
 *   for protected literal text
 * @param {Map<number, string>} source protected codepoint -> the source
 *   character its span opened with
 * @returns {string} the same text with matched delimiters deleted
 */
function stripEmphasis(text, source) {
  if (text.length === 0) return text;

  /** @type {Delim[]} */
  const delims = [];
  let headerIndex = 0;
  // Offset just past the previous delimiter's source coverage, or -2 before any
  // has been seen. Adjacency has to be measured in SOURCE OFFSETS and has to
  // account for a delimiter's span: the two `~~` of `~~~~` are adjacent and
  // share a run, while `~~` and a `_` that happen to be one column apart are
  // not. Comparing offsets alone treated the second `~~` of `~~~~` as a new run
  // and split the strikethrough, which is what left `~~<` in the anchor where
  // the renderer had already matched it.
  let previousEnd = -2;

  for (let i = 0; i < text.length; ) {
    const point = text.codePointAt(i);
    const width = String.fromCodePoint(point).length;
    const isProtected = source.has(point);
    if (isProtected || !DELIMITER_CHARS.has(String.fromCodePoint(point))) {
      i += width;
      continue;
    }
    const char = String.fromCodePoint(point);
    let end = i + width;
    while (end < text.length) {
      const next = text.codePointAt(end);
      if (source.has(next) || String.fromCodePoint(next) !== char) break;
      end += width;
    }
    // The flanking tests see the SOURCE character on either side, which is what
    // a renderer reads. Run detection above deliberately does not look inside a
    // protected span: `\*` is an asterisk, but it is a literal one, not a
    // delimiter. Confusing the two made `A \*b\* c` lose its asterisks.
    const flags = flanking(text, i, end, char, source);

    // GFM's strikethrough is `~~`, not `~`: a run of one tilde is literal text,
    // and a run of three is one literal tilde followed by a pair. markdown-it
    // pushes a pair's two tildes as ONE delimiter whose length is 0, which
    // disables the rule-of-three test for tildes -- and the same is done here.
    // Treating every `~` as an emphasis delimiter made `__ <!~_~____` slug to
    // `__-_____` where GitHub emits `__-___`.
    let runLength = end - i;
    let offset = i;
    if (char === '~') {
      if (runLength < 2) {
        i = end;
        continue;
      }
      if (runLength % 2 === 1) {
        offset += 1; // the leading lone tilde stays literal
        runLength -= 1;
      }
      const tildeFlags = { canOpen: flags.canOpen, canClose: flags.canClose };
      for (let k = 0; k < runLength; k += 2) {
        delims.push({
          char,
          offset: offset + k,
          span: 2,
          length: 0,
          canOpen: tildeFlags.canOpen,
          canClose: tildeFlags.canClose,
          end: -1,
        });
      }
      i = end;
      continue;
    }

    for (let k = 0; k < runLength; k += 1) {
      delims.push({
        char,
        offset: i + k,
        span: 1,
        length: runLength,
        canOpen: flags.canOpen,
        canClose: flags.canClose,
        // end is the index of the matching closer, -1 while unmatched. On a
        // match both ends stop being available, which is what stops a
        // delimiter from pairing twice.
        end: -1,
      });
    }
    i = end;
  }
  if (delims.length === 0) return text;

  const openersBottom = new Map();
  const jumps = new Array(delims.length).fill(0);
  const bottomFor = (delim) => `${delim.char}|${delim.canOpen ? 1 : 0}`;
  const bottomOf = (delim) => {
    const key = bottomFor(delim);
    if (!openersBottom.has(key)) openersBottom.set(key, [-1, -1, -1]);
    return openersBottom.get(key)[delim.length % 3];
  };
  const setBottom = (delim, value) => {
    const key = bottomFor(delim);
    if (!openersBottom.has(key)) openersBottom.set(key, [-1, -1, -1]);
    openersBottom.get(key)[delim.length % 3] = value;
  };

  let closerIndex = 0;
  while (closerIndex < delims.length) {
    const closer = delims[closerIndex];
    // Delimiters belong to one run when adjacent in the source AND the same
    // character; tracking that lets the opener search start at the run boundary.
    if (delims[headerIndex].char !== closer.char || previousEnd !== closer.offset) {
      headerIndex = closerIndex;
    }
    previousEnd = closer.offset + closer.span;

    if (!closer.canClose) {
      closerIndex += 1;
      continue;
    }

    const minOpenerIndex = bottomOf(closer);
    let openerIndex = headerIndex - jumps[headerIndex] - 1;
    let newMinOpenerIndex = openerIndex;
    while (openerIndex > minOpenerIndex) {
      const opener = delims[openerIndex];
      if (opener.char !== closer.char) {
        openerIndex -= jumps[openerIndex] + 1;
        continue;
      }
      if (opener.canOpen && opener.end < 0) {
        // Rule of three, on the ORIGINAL run lengths: if one of the two can
        // both open and close, their run lengths must not sum to a multiple of
        // 3 unless both are multiples of 3 themselves.
        const oddMatch =
          (opener.canClose || closer.canOpen) &&
          (opener.length + closer.length) % 3 === 0 &&
          (opener.length % 3 !== 0 || closer.length % 3 !== 0);
        if (!oddMatch) {
          // Delimiters before an opener that cannot open can be skipped
          // wholesale next time. This is what keeps the algorithm linear.
          const lastJump =
            openerIndex > 0 && !delims[openerIndex - 1].canOpen ? jumps[openerIndex - 1] + 1 : 0;
          jumps[closerIndex] = closerIndex - openerIndex + lastJump;
          jumps[openerIndex] = lastJump;

          closer.canOpen = false;
          opener.end = closerIndex;
          // An opener is matched at most once; clearing canClose stops the
          // same delimiter being reused as a closer later.
          opener.canClose = false;
          newMinOpenerIndex = -1;
          previousEnd = -2;
          break;
        }
      }
      openerIndex -= jumps[openerIndex] + 1;
    }
    if (newMinOpenerIndex !== -1) setBottom(closer, newMinOpenerIndex);
    closerIndex += 1;
  }

  // A matched pair becomes <em>/<strong>: both ends vanish. Everything else
  // stays literal, which is the whole point -- `_a` renders as `_a` because
  // that leading `_` never found a closer, not because it was "protected".
  const matched = new Set();
  for (const delim of delims) {
    if (delim.end >= 0) {
      for (let k = 0; k < delim.span; k += 1) matched.add(delim.offset + k);
      const closer = delims[delim.end];
      for (let k = 0; k < closer.span; k += 1) matched.add(closer.offset + k);
    }
  }
  const drop = new Array(text.length).fill(false);
  for (const offset of matched) drop[offset] = true;
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (drop[i]) {
      i += 1;
      continue;
    }
    const point = text.codePointAt(i);
    out += String.fromCodePoint(point);
    i += String.fromCodePoint(point).length;
  }
  return out;
}

/**
 * Replace every code span with a placeholder, in one left-to-right pass.
 *
 * The rules this has to get right, all of which were wrong before it existed:
 *
 *   - A backslash escape is stepped over WITHOUT being interpreted when it
 *     could be an OPENER. Inside a code span nothing is markup, so `\_` there
 *     is two characters; outside one, `\`` means that backtick is literal and
 *     must not be counted as an opener -- otherwise `` \`~~< x `` ` pairs the
 *     escaped backtick with a later unrelated one and swallows the text
 *     between. The SAME escape does not shield the CLOSER search; see below.
 *   - The closer must be a run of EXACTLY the opening length. `` `a`` `` has no
 *     code span: two backticks cannot close a one-backtick opener, they are
 *     text. Matching with a plain backreference consumed the first backtick of
 *     the longer run and treated what followed as code.
 *   - An opener with no matching closer is not markup at all, and neither is a
 *     lone backtick. Crucially the text after an unmatched opener stays in the
 *     SOURCE: a renderer that finds no closer keeps scanning for one, so the
 *     backtick and everything after it keep their markdown meaning. Swallowing
 *     the tail instead turned `_`x`,>_` into `x,>`, losing an underscore the
 *     reader can see.
 *
 * @param {string} s raw heading source
 * @param {(text: string, opener: string) => string} protect
 * @returns {string}
 */
function claimCodeSpans(s, protect) {
  if (!s.includes('`')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const char = s[i];
    // Step over an escape pair without resolving it. The escaped character is
    // emitted verbatim; whatever it is, it cannot open a code span.
    if (char === '\\' && i + 1 < s.length) {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char !== '`') {
      out += char;
      i += 1;
      continue;
    }
    let runEnd = i;
    while (runEnd < s.length && s[runEnd] === '`') runEnd += 1;
    const width = runEnd - i;
    // Find the next run of exactly this many backticks. This scan is RAW: a
    // backslash does NOT shield a backtick here, because a renderer's closer
    // search is a plain "find the next backtick" scan over the source with no
    // escape handling at all (markdown-it's backticks rule does
    // `state.src.index('`', ...)`, verified against its tokens). So in
    // `` `a\`b` `` the escaped backtick is the CLOSER: one code span whose
    // content is `a\`, and the `b\`` after it is literal text. Skipping escapes
    // here instead left that span unclosed and lost an underscore the reader
    // can see -- `\_a _`___,\`,>_` slugged to `_a-_` where the renderer emits
    // `_a ___,\,>_`.
    //
    // Escapes are honoured for the OPENER only -- the main loop above steps
    // over `\`` without interpreting it, because the escape rule runs first and
    // an escaped backtick never becomes a delimiter. The asymmetry is the
    // renderer's, not a convenience: openers are found by the inline tokenizer
    // (which handles escapes) and closers by a raw scan (which does not).
    let search = runEnd;
    let closeStart = -1;
    while (search < s.length) {
      if (s[search] !== '`') {
        search += 1;
        continue;
      }
      let end = search;
      while (end < s.length && s[end] === '`') end += 1;
      if (end - search === width) {
        closeStart = search;
        break;
      }
      // A different-width run is not a closer; keep looking past it.
      search = end;
    }
    if (closeStart === -1) {
      // No closer: the backticks are literal text.
      out += s.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    out += protect(codeSpanContent(s.slice(runEnd, closeStart)), '`');
    i = closeStart + width;
  }
  return out;
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
  // The SOURCE character each protected span opened with. Emphasis flanking is
  // decided by a renderer from raw source, so a code span looks like a backtick
  // to the delimiter tests even though it renders as its contents.
  /** @type {Map<number, string>} private-use codepoint -> source opener */
  const sourceOpeners = new Map();
  let nextPoint = 0xe000;
  /**
   * @param {string} text literal text to protect
   * @param {string} opener the source character this span opened with
   * @returns {string}
   */
  const protect = (text, opener) => {
    const point = nextPoint++;
    literal.set(point, text);
    sourceOpeners.set(point, opener);
    return String.fromCodePoint(point);
  };

  let out = String(s);

  // Code spans are claimed in a single left-to-right scan, BEFORE escapes are
  // resolved, and the two rules are entangled enough that regexes in sequence
  // cannot express them:
  //
  //   - inside a code span nothing is markup, so the `\_` in `` `\_x` `` is a
  //     backslash and an underscore;
  //   - outside one, `\`` is a literal backtick and cannot OPEN a span. A `\`
  //     that vanishes before the scanner runs leaves a bare backtick, which the
  //     scanner then pairs with an unrelated later backtick -- `\`~~< __!__``
  //     became one code span and the heading lost `~~< __!__`.
  //
  // So the scan walks the raw source, stepping over an escape without
  // interpreting it, and a closer must be a run of exactly the opening length:
  // `` `a`` `` has no code span at all, because its only candidate closer is two
  // backticks long. Matching a bare `\1` against the first backtick of a longer
  // run treated the text between as code and deleted emphasis the reader sees.
  out = claimCodeSpans(out, protect);

  // Now the escapes that survived outside a code span. CommonMark: "Any ASCII
  // punctuation character may be backslash-escaped." The class below is all 32
  // of them, as four ranges. It was previously shorter -- only the characters
  // Markdown's own syntax cares about -- so `\<` and `\>` stayed raw source and
  // the HTML tag stripper then ate `<a>` as a tag, deleting text the reader
  // sees.
  out = out.replace(/\\([!-\/:-@\[-`{-~])/g, (_m, ch) => protect(ch, '\\'));

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
    protect(uriBody === undefined ? emailBody : uriBody, '<')
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

  // Emphasis, strong and strikethrough. Resolved by the CommonMark delimiter
  // algorithm above rather than by regexes, so the intraword rule (`snake_case`
  // and `_leading` both render literally) comes out right for the reason the
  // spec says it does. An underscore is the delimiter that matters here:
  // github-slugger's strip table keeps it and drops `*` and `~`, so an `_` is
  // the only emphasis character whose wrong handling moves an anchor.
  //
  // Runs before the protected literal text is restored. The flanking tests read
  // the SOURCE character each placeholder stands for, because that is what a
  // renderer reads: a code span opens with a backtick in the source, so `` `a`* ``
  // cannot open on that `*`.
  out = stripEmphasis(out, sourceOpeners);

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
