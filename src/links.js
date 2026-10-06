'use strict';

const { normalizeLabel } = require('./slug.js');

/**
 * mdcheck / links.js
 *
 * Extracts links, images, autolinks and reference definitions from markdown
 * without a full parser. This is a line-oriented scanner, not a CommonMark
 * parser: it is correct for the things mdcheck cares about (where does this
 * link point, and what is on this line) and deliberately quiet about
 * everything else.
 *
 * Two things are skipped because a link inside them is not a link:
 *
 *   - Fenced code blocks. Both ``` and ~~~ open a fence, fences longer than
 *     three characters are allowed (```` ``` ```` is legal), a fence closes
 *     only on a fence of the *same* character that is at least as long as the
 *     opener, and a 4-backtick fence can therefore contain a 3-backtick fence
 *     without ending. Fences may be indented up to three spaces. An opening
 *     backtick fence whose info string contains a backtick is not a fence.
 *   - Inline code spans. A code span opens with a run of N backticks and
 *     closes on the next run of exactly N backticks, so ``` ``a ` b`` ``` is
 *     one span. Code span contents are blanked out (replaced with spaces) in a
 *     masked copy of the line, which keeps every reported column accurate while
 *     stopping the link patterns from matching inside them.
 */

/** Link-like things this module knows how to find. */
const KIND = Object.freeze({
  INLINE: 'inline',
  IMAGE: 'image',
  AUTOLINK: 'autolink',
  REFERENCE_USAGE: 'reference-usage',
  DEFINITION: 'definition',
});

/** Any URL with a scheme, e.g. https:, mailto:, ftp:. */
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** A bare email autolink, e.g. <user@example.com>. Has no scheme but is still
 *  an external destination, not a relative file. */
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

/**
 * Blank out inline code spans in a line, preserving length and columns.
 * @param {string} line
 * @returns {{text: string, spans: Array<{start: number, end: number}>}}
 */
function maskCodeSpans(line) {
  const out = line.split('');
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      i += 1;
      continue;
    }
    let openLen = 0;
    while (i + openLen < line.length && line[i + openLen] === '`') openLen += 1;
    // Find the next run of exactly openLen backticks.
    let j = i + openLen;
    let closeLen = 0;
    while (j < line.length) {
      if (line[j] !== '`') {
        j += 1;
        continue;
      }
      closeLen = 0;
      while (j + closeLen < line.length && line[j + closeLen] === '`') closeLen += 1;
      if (closeLen === openLen) break;
      j += closeLen;
    }
    if (j >= line.length || closeLen !== openLen) {
      // Unclosed code span: CommonMark treats the rest of the block as code.
      for (let k = i; k < line.length; k += 1) out[k] = ' ';
      spans.push({ start: i, end: line.length });
      return { text: out.join(''), spans };
    }
    for (let k = i; k < j + closeLen; k += 1) out[k] = ' ';
    spans.push({ start: i, end: j + closeLen });
    i = j + closeLen;
  }
  return { text: out.join(''), spans };
}

/**
 * Find the index just past the `]` that closes the `[` at `start`, or -1.
 * Nested brackets are counted; code spans are already spaces by now.
 * @param {string} masked line with code spans blanked
 * @param {number} start index of the opening '['
 * @returns {number}
 */
function findLabelEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Scan a balanced parenthesized group starting at `open` (which must be '(').
 * @param {string} masked
 * @param {number} open
 * @returns {number} index just past the ')', or -1 if unbalanced
 */
function findParenEnd(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The destination text exactly as written between the parens, with only
 * *leading* whitespace removed and any trailing whitespace kept. Keeping it is
 * what lets mdcheck report "[a](x.md )" as a trailing-whitespace bug: the space
 * is part of the URL a renderer will use, and it only exists in the source.
 * @param {string} inner the text between the parentheses
 * @returns {string}
 */
function rawDestinationSpan(inner) {
  return String(inner).replace(/^[ \t]+/, '');
}

/**
 * @param {string} inner
 * @returns {{destination: string, title: string|null, ok: boolean}}
 */
function parseDestinationAndTitle(inner) {
  let s = inner;
  let destination = '';
  let i = 0;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (s[i] === '<') {
    const close = s.indexOf('>', i + 1);
    if (close === -1) return { destination: '', title: null, ok: false };
    destination = s.slice(i + 1, close);
    i = close + 1;
  } else {
    while (i < s.length && !/\s/.test(s[i])) {
      if (s[i] === '\\' && i + 1 < s.length) i += 1;
      i += 1;
      destination += s[i - 1];
    }
  }
  while (i < s.length && /\s/.test(s[i])) i += 1;
  let title = null;
  const quote = s[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    const close = s.indexOf(closer, i + 1);
    if (close !== -1) {
      title = s.slice(i + 1, close);
      i = close + 1;
    }
  }
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return { destination, title, ok: i >= s.length };
}

/**
 * A link target split into its parts.
 * @typedef {object} ParsedTarget
 * @property {string} raw the destination exactly as written
 * @property {string} file the file part ('' when the link is anchor-only)
 * @property {string} anchor the anchor part, percent-decoded, no leading '#'
 * @property {boolean} external true for any URL with a scheme
 * @property {boolean} absolute true when the file part starts with '/'
 * @property {boolean} empty true when the whole destination is blank
 */

/**
 * Split "docs/a.md#anchor" into its pieces.
 * @param {string} dest
 * @returns {ParsedTarget}
 */
function parseTarget(dest) {
  const raw = String(dest);
  const trimmed = raw.trim();
  const hash = trimmed.indexOf('#');
  const file = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const anchorRaw = hash === -1 ? '' : trimmed.slice(hash + 1);
  let anchor = anchorRaw;
  try {
    anchor = decodeURIComponent(anchorRaw);
  } catch {
    // Leave a malformed percent-escape as-is; it simply will not match.
  }
  return {
    raw,
    file,
    anchor,
    external: EXTERNAL_SCHEME.test(trimmed) || EMAIL.test(trimmed),
    absolute: file.startsWith('/'),
    empty: trimmed.length === 0,
  };
}

/**
 * Track fenced-code-block state while walking lines.
 */
class FenceTracker {
  constructor() {
    /** @type {{char: string, len: number, line: number, column: number}|null} */
    this.open = null;
    /** @type {{line: number, column: number}|null} */
    this.unclosed = null;
  }

  /**
   * Feed one line.
   * @param {string} line
   * @param {number} lineNumber 1-based
   * @returns {boolean} true when the line is inside (or opens) a fence
   */
  isFenced(line, lineNumber) {
    const indentMatch = /^ {0,3}/.exec(line);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const rest = line.slice(indent);

    if (this.open) {
      // Closing fence: same char, at least as long, nothing else on the line.
      const m = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
      if (m && m[1][0] === this.open.char && m[1].length >= this.open.len) {
        this.open = null;
        return true;
      }
      return true;
    }

    const openMatch = /^(`{3,}|~{3,})(.*)$/.exec(rest);
    if (openMatch) {
      const marker = openMatch[1];
      const info = openMatch[2];
      // A backtick fence's info string may not contain a backtick.
      if (marker[0] === '`' && info.includes('`')) return false;
      this.open = {
        char: marker[0],
        len: marker.length,
        line: lineNumber,
        column: indent + 1,
      };
      return true;
    }
    return false;
  }

  /** @returns {{line: number, column: number}|null} unclosed opener, if any */
  finish() {
    return this.open ? { line: this.open.line, column: this.open.column } : null;
  }
}

/**
 * Everything found in one document.
 * @typedef {object} Document
 * @property {Array<object>} links every reference found (see KIND)
 * @property {Map<string, object>} definitions normalized label -> definition
 * @property {Array<object>} headings heading slugs, in document order
 * @property {Array<{line: number, column: number}>} unclosedFences
 */

/**
 * Extract all link-ish structures from markdown source.
 * @param {string} source
 * @returns {Document}
 */
function extract(source) {
  const lines = String(source).split(/\r\n|\r|\n/);
  const fence = new FenceTracker();
  const links = [];
  const headings = [];
  const unclosedFences = [];
  let inParagraph = false;
  // The paragraph currently being accumulated, or null. Setext headings can
  // only be recognised by looking back at the paragraph they terminate, so the
  // text is buffered rather than slung on the previous line.
  /** @type {{lines: string[], startLine: number}|null} */
  let pendingParagraph = null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineNumber = idx + 1;

    if (fence.isFenced(line, lineNumber)) {
      // A fence interrupts an open paragraph: the text before it is not
      // available to a later setext underline.
      pendingParagraph = null;
      inParagraph = false;
      continue;
    }

    const blank = /^[ \t]*$/.test(line);

    // A setext underline turns the paragraph above it into a heading, and it
    // does so *only* when a paragraph is open -- cmark-gfm's
    // `scan_setext_heading_line` is reached solely from the
    // `cont_type == CMARK_NODE_PARAGRAPH` branch of `open_new_blocks`.
    // `===` is level 1, `---` is level 2. An underline with no paragraph above
    // it (after a blank line, after another heading) is a thematic break.
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (underline && pendingParagraph && inParagraph) {
      headings.push({
        level: underline[1][0] === '=' ? 1 : 2,
        // Lines are joined with a space, not a newline. A soft line break
        // inside a paragraph is rendered as a space, so the heading's text
        // content is "Setext Beta spans two source lines" -- joining with "\n"
        // instead would let the strip table delete it outright and yield
        // "setext-betaspans-twosource-lines".
        text: pendingParagraph.lines.join(' '),
        line: pendingParagraph.startLine,
        column: 1,
      });
      pendingParagraph = null;
      inParagraph = false;
      continue;
    }

    if (underline) {
      // A thematic break. It ends any paragraph but contributes no text.
      pendingParagraph = null;
      inParagraph = false;
      continue;
    }

    // An indented code block: 4+ spaces (or a tab) at the start of a line that
    // does not continue a paragraph. CommonMark calls a line that follows a
    // paragraph but is itself indented a *lazy continuation* -- still
    // paragraph text, so its links are real. Tracking "are we inside a
    // paragraph" is therefore required; looking only at the previous line's
    // indentation is not enough, because a blank line also ends a paragraph
    // while an unindented line does not.
    if (!blank) {
      const indentWidth = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      const isLazyContinuation = inParagraph && indentWidth > 0;
      if (indentWidth >= 4 && !isLazyContinuation) {
        inParagraph = false;
        pendingParagraph = null;
        continue;
      }
      inParagraph = true;
    } else {
      // A blank line ends a paragraph but does not end an indented code block;
      // the code continues on the next line if that line is also indented.
      inParagraph = false;
      pendingParagraph = null;
    }

    const { text: masked } = maskCodeSpans(line);

    // Headings. ATX form (`## Title`) is self-identifying on one line. A setext
    // underline was already handled above, before its text was accumulated.
    //
    // An ATX heading may be EMPTY. CommonMark 0.31.2 says so explicitly ("ATX
    // headings can be empty") and its example renders `#` as <h1></h1>, so the
    // separator between the hashes and the text is OPTIONAL. The old pattern
    // demanded a space or tab, which made a bare `#` fall through to the
    // paragraph branch: the heading was parsed as text and simply did not exist
    // as far as the document was concerned. That lost a real anchor -- anything
    // linked to `#` was reported as dangling -- and, because the heading never
    // entered the Slugger, a second empty heading never got its `-1` suffix:
    // the anchors came out "" and "" instead of "" and "-1", so a link to `#-1`
    // was reported dangling on a page where it works.
    //
    // The optional group must not swallow the hashes themselves. The trailing
    // boundary is what keeps SEVEN hashes a paragraph rather than a level-6
    // heading whose text is the literal `#`: the opening run has to stop at the
    // first character that is neither a hash nor a separator, so `#{1,6}` is
    // followed by a negative lookahead for another `#`. Without it the regex is
    // free to open on the first six and treat the seventh as content -- and
    // CommonMark's own example (`####### foo`, which renders as a paragraph)
    // becomes an h6.
    const h = /^ {0,3}(#{1,6})(?!#)(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line);
    if (h) {
      headings.push({
        level: h[1].length,
        text: h[2] === undefined ? '' : h[2],
        line: lineNumber,
        column: 1,
      });
      // An ATX heading is not a paragraph, so a `---` after it is a thematic
      // break rather than a level-2 heading.
      pendingParagraph = null;
      inParagraph = false;
    } else if (inParagraph) {
      // Trailing whitespace is stripped from every line of a paragraph before
      // the paragraph becomes a heading's text, so `Title   ` slugs as `title`
      // and not `title--`. This mirrors cmark-gfm's
      // `remove_trailing_blank_lines`, which runs over the paragraph buffer when
      // the block is finalized -- verified against a real file whose setext H1
      // carries two trailing spaces.
      const trimmed = line.replace(/[ \t]+$/, '');
      if (pendingParagraph) pendingParagraph.lines.push(trimmed);
      else pendingParagraph = { lines: [trimmed], startLine: lineNumber };
    }

    // Indented code blocks (4+ spaces, only when not continuing a paragraph).
    // Detected cheaply: a line starting with 4 spaces/tabs that has a link.
    let i = 0;
    while (i < masked.length) {
      const ch = masked[i];

      // Autolink: <scheme:...> or <user@host>
      if (ch === '<') {
        const close = masked.indexOf('>', i + 1);
        if (close !== -1) {
          const body = line.slice(i + 1, close);
          // A scheme followed by anything (including nothing) is an autolink:
          // "https://" and "mailto:" are malformed URLs, but they are still
          // autolinks, and mdcheck reports them rather than silently skipping.
          const isUri = /^[a-z][a-z0-9+.-]*:[^\s<>]*$/i.test(body);
          const isEmail = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(body);
          if (isUri || isEmail) {
            links.push({
              kind: KIND.AUTOLINK,
              destination: body,
              title: null,
              label: body,
              referenceId: null,
              text: null,
              line: lineNumber,
              column: i + 1,
              definition: false,
            });
            i = close + 1;
            continue;
          }
        }
      }

      // Reference definition: [id]: dest "title" at the start of a line block.
      const defMatch = /^ {0,3}\[((?:[^\][\\]|\\.)*)\]:/.exec(masked.slice(i));
      if (defMatch && (i === 0 || !/[^\s]/.test(masked[i - 1]))) {
        const rawLabel = defMatch[1];
        const afterColon = i + defMatch[0].length;
        const { text: afterMask } = maskCodeSpans(line);
        const tail = afterMask.slice(afterColon);
        if (/^[\s]*$/.test(tail)) continue; // empty definition: nothing to point at
        const destMatch = /^\s*(<[^>]*>|[^\s]+)/.exec(tail);
        if (destMatch) {
          let dest = destMatch[1];
          const destOffset = afterColon + destMatch.index + destMatch[0].length - dest.length;
          if (dest.startsWith('<') && dest.endsWith('>')) {
            dest = dest.slice(1, -1);
          }
          const restStart = afterColon + destMatch.index + destMatch[0].length;
          const titleMatch = /^[ \t]+("([^"]*)"|'([^']*)'|\(([^)]*)\))/.exec(line.slice(restStart));
          links.push({
            kind: KIND.DEFINITION,
            destination: dest,
            rawDestination: dest,
            title: titleMatch ? (titleMatch[2] ?? titleMatch[3] ?? titleMatch[4]) : null,
            label: rawLabel,
            referenceId: normalizeLabel(rawLabel),
            text: null,
            line: lineNumber,
            column: i + 1,
            definition: true,
            destColumn: destOffset + 1,
          });
          i = restStart;
          continue;
        }
      }

      if (ch === '!' && masked[i + 1] === '[') {
        const labelEnd = findLabelEnd(masked, i + 1);
        if (labelEnd === -1) {
          i += 1;
          continue;
        }
        if (masked[labelEnd + 1] === '(') {
          const parenEnd = findParenEnd(masked, labelEnd + 1);
          if (parenEnd === -1) {
            links.push({
              kind: KIND.IMAGE,
              destination: null,
              title: null,
              label: line.slice(i + 2, labelEnd),
              referenceId: null,
              text: null,
              line: lineNumber,
              column: i + 1,
              definition: false,
              malformed: 'image destination is missing a closing ")": ' + line.trim(),
            });
            i = labelEnd + 1;
            continue;
          }
          const inner = line.slice(labelEnd + 2, parenEnd - 1);
          const parsed = parseDestinationAndTitle(inner);
          links.push({
            kind: KIND.IMAGE,
            destination: parsed.destination,
            rawDestination: rawDestinationSpan(inner),
            title: parsed.title,
            label: line.slice(i + 2, labelEnd),
            referenceId: null,
            text: null,
            line: lineNumber,
            column: i + 1,
            definition: false,
            ...(parsed.ok ? {} : { malformed: 'unexpected text after image destination: ' + line.trim() }),
          });
          i = parenEnd;
          continue;
        }
        i += 2;
        continue;
      }

      if (ch === '[') {
        const labelEnd = findLabelEnd(masked, i);
        if (labelEnd === -1) {
          i += 1;
          continue;
        }
        const label = line.slice(i + 1, labelEnd);
        const after = masked[labelEnd + 1];

        if (after === '(') {
          const parenEnd = findParenEnd(masked, labelEnd + 1);
          if (parenEnd === -1) {
            links.push({
              kind: KIND.INLINE,
              destination: null,
              title: null,
              label,
              referenceId: null,
              text: null,
              line: lineNumber,
              column: i + 1,
              definition: false,
              malformed: 'link destination is missing a closing ")": ' + line.trim(),
            });
            i = labelEnd + 1;
            continue;
          }
          const inner = line.slice(labelEnd + 2, parenEnd - 1);
          const parsed = parseDestinationAndTitle(inner);
          links.push({
            kind: KIND.INLINE,
            destination: parsed.destination,
            // The untrimmed destination span, so a trailing space that
            // parseDestinationAndTitle removed is still detectable: "[a](x.md )"
            // is a real 404 and the space only exists in the source line.
            rawDestination: rawDestinationSpan(inner),
            title: parsed.title,
            label,
            referenceId: null,
            text: null,
            line: lineNumber,
            column: i + 1,
            definition: false,
            ...(parsed.ok ? {} : { malformed: 'unexpected text after link destination: ' + line.trim() }),
          });
          i = parenEnd;
          continue;
        }

        if (after === '[') {
          const refEnd = findLabelEnd(masked, labelEnd + 1);
          if (refEnd === -1) {
            i += 1;
            continue;
          }
          const inner = line.slice(labelEnd + 2, refEnd);
          links.push({
            kind: KIND.REFERENCE_USAGE,
            destination: null,
            title: null,
            label,
            referenceId: normalizeLabel(inner || label),
            text: label,
            line: lineNumber,
            column: i + 1,
            definition: false,
            collapsed: inner.length === 0,
          });
          i = refEnd + 1;
          continue;
        }

        // Shortcut reference [id] -- only counts as one if the label is
        // actually defined somewhere in the document, which the caller checks.
        links.push({
          kind: KIND.REFERENCE_USAGE,
          destination: null,
          title: null,
          label,
          referenceId: normalizeLabel(label),
          text: label,
          line: lineNumber,
          column: i + 1,
          definition: false,
          shortcut: true,
        });
        i = labelEnd + 1;
        continue;
      }

      i += 1;
    }
  }

  const unclosed = fence.finish();
  if (unclosed) unclosedFences.push(unclosed);

  // Reference definitions: first definition of a label wins (CommonMark).
  const definitions = new Map();
  for (const link of links) {
    if (!link.definition) continue;
    if (!definitions.has(link.referenceId)) definitions.set(link.referenceId, link);
  }

  return { links, definitions, headings, unclosedFences };
}

module.exports = {
  KIND,
  FenceTracker,
  maskCodeSpans,
  parseDestinationAndTitle,
  parseTarget,
  extract,
};
