'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  extract,
  parseTarget,
  parseDestinationAndTitle,
  maskCodeSpans,
  FenceTracker,
  KIND,
} = require('../src/links.js');

/** Convenience: the links a markdown source yields, as [line, destination]. */
const linksOf = (md) => extract(md).links.map((l) => [l.line, l.destination]);

/** Convenience: just the lines that produced a link. */
const linesOf = (md) => extract(md).links.map((l) => l.line);

test('extracts inline links with position', () => {
  const md = 'text [label](docs/a.md) more';
  const [link] = extract(md).links;
  assert.strictEqual(link.kind, KIND.INLINE);
  assert.strictEqual(link.destination, 'docs/a.md');
  assert.strictEqual(link.label, 'label');
  assert.strictEqual(link.line, 1);
  assert.strictEqual(link.column, 6);
});

test('extracts images separately from links', () => {
  const [image] = extract('![alt text](assets/pic.png)').links;
  assert.strictEqual(image.kind, KIND.IMAGE);
  assert.strictEqual(image.destination, 'assets/pic.png');
  assert.strictEqual(image.label, 'alt text');
});

test('extracts autolinks for URLs and mailto', () => {
  assert.deepStrictEqual(
    linksOf('<https://example.com/x>'),
    [[1, 'https://example.com/x']]
  );
  assert.deepStrictEqual(linksOf('<mailto:a@b.com>'), [[1, 'mailto:a@b.com']]);
  assert.deepStrictEqual(linksOf('<a@b.com>'), [[1, 'a@b.com']]);
});

test('does not treat an HTML tag as an autolink', () => {
  assert.deepStrictEqual(linesOf('see <br> and <div>'), []);
});

test('strips the optional title from a destination', () => {
  assert.deepStrictEqual(linksOf('[a](x.md "Title")'), [[1, 'x.md']]);
  assert.deepStrictEqual(linksOf("[a](x.md 'Title')"), [[1, 'x.md']]);
  assert.deepStrictEqual(linksOf('[a](x.md (Title))'), [[1, 'x.md']]);
  const [link] = extract('[a](x.md "Title")').links;
  assert.strictEqual(link.title, 'Title');
});

test('handles angle-bracket destinations with spaces', () => {
  assert.deepStrictEqual(linksOf('[a](<my file.md> "T")'), [[1, 'my file.md']]);
});

test('extracts reference definitions', () => {
  const doc = extract('[id]: docs/c.md "Ref title"');
  assert.strictEqual(doc.links.length, 1);
  assert.strictEqual(doc.links[0].kind, KIND.DEFINITION);
  assert.strictEqual(doc.links[0].referenceId, 'id');
  assert.strictEqual(doc.links[0].destination, 'docs/c.md');
  assert.strictEqual(doc.links[0].title, 'Ref title');
  assert.ok(doc.definitions.has('id'));
});

test('records reference usages, full and collapsed and shortcut', () => {
  const doc = extract('[text][id]\n\n[collapsed][]\n\n[shortcut]');
  const kinds = doc.links.map((l) => l.kind);
  assert.deepStrictEqual(kinds, [
    KIND.REFERENCE_USAGE,
    KIND.REFERENCE_USAGE,
    KIND.REFERENCE_USAGE,
  ]);
  assert.strictEqual(doc.links[0].referenceId, 'id');
  assert.strictEqual(doc.links[1].referenceId, 'collapsed');
  assert.strictEqual(doc.links[1].collapsed, true);
  assert.strictEqual(doc.links[2].referenceId, 'shortcut');
  assert.strictEqual(doc.links[2].shortcut, true);
});

test('reference labels match case-insensitively with collapsed whitespace', () => {
  const doc = extract('[My Ref]: x.md\n\nSee [text][MY   ref].');
  assert.ok(doc.definitions.has('my ref'));
  assert.strictEqual(doc.links[1].referenceId, 'my ref');
});

test('does not extract links inside a backtick fence', () => {
  const md = '```\n[a](x.md)\n[b](y.md)\n```\n[c](z.md)';
  assert.deepStrictEqual(linesOf(md), [5]);
});

test('does not extract links inside a tilde fence', () => {
  const md = '~~~~~\n[a](x.md)\n~~~~~\n[b](y.md)';
  assert.deepStrictEqual(linesOf(md), [4]);
});

test('a 4-backtick fence can contain a 3-backtick fence', () => {
  const md = '````\n[a](x.md)\n```\n[b](y.md)\n```\n[c](y.md)\n````\n[d](z.md)';
  // Everything up to the 4-backtick closer is code, including the inner fence.
  assert.deepStrictEqual(linesOf(md), [8]);
});

test('a fence closes only on the same character and length or longer', () => {
  // A ~~~ run does not close a ``` fence, and vice versa.
  const tildeThenBacktick = '~~~\n[a](x.md)\n```\n[b](y.md)\n~~~\n[c](z.md)';
  assert.deepStrictEqual(linesOf(tildeThenBacktick), [6]);
  const backtickThenTilde = '```\n[a](x.md)\n~~~\n[b](y.md)\n```\n[c](z.md)';
  assert.deepStrictEqual(linesOf(backtickThenTilde), [6]);
  // A 3-backtick run does not close a 4-backtick fence.
  const shorterClose = '````\n[a](x.md)\n```\n[b](y.md)\n````\n[c](z.md)';
  assert.deepStrictEqual(linesOf(shorterClose), [6]);
});

test('a fence may be indented up to three spaces', () => {
  assert.deepStrictEqual(linesOf('   ```\n[a](x.md)\n   ```\n[b](y.md)'), [4]);
  // Four spaces is an indented code block, so the link inside is code.
  assert.deepStrictEqual(linesOf('text\n\n    [a](x.md)'), []);
});

test('an indented line inside a paragraph is a lazy continuation', () => {
  // CommonMark: an indented line that follows a paragraph without a blank line
  // is still paragraph text, so its link is a real link.
  const md = 'Some paragraph text\n    [lazy](x.md)\n\n    [indented code](y.md)';
  assert.deepStrictEqual(linesOf(md), [2]);
});

test('a backtick fence info string may not contain a backtick', () => {
  // '```a`b' is not a fence opener, so the next line's link is a real link.
  assert.deepStrictEqual(linesOf('```a`b\n[c](x.md)'), [2]);
});

test('reports an unclosed code fence', () => {
  const doc = extract('# H\n\n```\n[a](x.md)\n[b](y.md)');
  assert.deepStrictEqual(doc.unclosedFences, [{ line: 3, column: 1 }]);
  assert.deepStrictEqual(doc.links.map((l) => l.line), []);
});

test('a closed fence leaves no unclosed-fence diagnostic', () => {
  assert.deepStrictEqual(extract('```\nx\n```\n[y](z.md)').unclosedFences, []);
});

test('does not extract links inside an inline code span', () => {
  assert.deepStrictEqual(linesOf('see `[a](x.md)` here'), []);
  assert.deepStrictEqual(linesOf('`[a](x.md)` `[b](y.md)`'), []);
});

test('a code span may contain links and other inline code', () => {
  const md = '``a `[b](x.md)` c`` and [real](y.md)';
  assert.deepStrictEqual(linesOf(md), [1]);
  assert.strictEqual(extract(md).links[0].destination, 'y.md');
});

test('an unclosed inline code span swallows the rest of the line', () => {
  assert.deepStrictEqual(linesOf('text `[a](x.md) more'), []);
});

test('maskCodeSpans preserves length and column positions', () => {
  const line = 'a `code` b';
  const { text } = maskCodeSpans(line);
  // Length is what keeps reported columns accurate.
  assert.strictEqual(text.length, line.length);
  assert.strictEqual(text.slice(0, 2), 'a ');
  assert.strictEqual(text.slice(8, 11), ' b');
  assert.ok(!text.includes('`'));
});

test('flags a link with an unclosed parenthesis', () => {
  const [link] = extract('see [text](docs/a.md and more').links;
  assert.ok(link.malformed, 'expected a malformed diagnostic');
  assert.match(link.malformed, /closing "\)"/);
});

test('flags a link with an unclosed bracket', () => {
  // An unterminated "[" yields no link at all rather than a wrong one.
  assert.deepStrictEqual(linesOf('text [unclosed and more'), []);
});

test('handles nested brackets in link text', () => {
  assert.deepStrictEqual(linksOf('[a [b] c](x.md)'), [[1, 'x.md']]);
});

test('handles parentheses inside a destination', () => {
  assert.deepStrictEqual(linksOf('[a](x(1).md)'), [[1, 'x(1).md']]);
});

test('collects headings with their level and line', () => {
  const doc = extract('# One\n\n## Two\n\n### Three ###\n####Not a heading');
  assert.deepStrictEqual(
    doc.headings.map((h) => [h.level, h.text]),
    [[1, 'One'], [2, 'Two'], [3, 'Three']]
  );
  assert.strictEqual(doc.headings[0].line, 1);
});

test('findings inside a fenced block do not include headings', () => {
  const doc = extract('```\n# Not a heading\n```\n# Real');
  assert.deepStrictEqual(
    doc.headings.map((h) => h.text),
    ['Real']
  );
});

test('an ATX heading with no text is still a heading', () => {
  // CommonMark 0.31.2 section "ATX headings" says they "can be empty", and its
  // own example renders `#` as <h1></h1>. The heading therefore exists, slugs to
  // the empty string, and owns an anchor -- so `[x](#)` and every duplicate
  // after it resolve against a real heading rather than against nothing.
  //
  // The pattern this replaces required a space or tab after the hashes, so a
  // bare `#` fell through to the paragraph branch and was recorded as text. The
  // heading vanished from the document: its anchor was never emitted, so a
  // SECOND empty heading never got its `-1` suffix either and a link to `#-1`
  // was reported dangling on a page where it resolves.
  for (const [source, level] of [
    ['#', 1],
    ['##', 2],
    ['######', 6],
    ['  #', 1],
    ['   ##', 2],
  ]) {
    const doc = extract(source);
    assert.deepStrictEqual(
      doc.headings.map((h) => [h.level, h.text, h.line]),
      [[level, '', 1]],
      `${JSON.stringify(source)} should be an empty level-${level} heading`
    );
  }

  // `# ` (with the trailing space) already worked and must keep working.
  assert.deepStrictEqual(extract('# ').headings.map((h) => [h.level, h.text]), [[1, '']]);

  // A closing sequence is still text, not emptiness: `# # #` is an h1 whose
  // content is the literal text `#`.
  assert.deepStrictEqual(extract('# # #').headings.map((h) => [h.level, h.text]), [[1, '#']]);

  // Seven hashes is a paragraph, and four spaces of indent is code. Neither is
  // an empty heading, and neither was ever meant to be.
  assert.deepStrictEqual(extract('#######').headings, []);
  assert.deepStrictEqual(extract('    #').headings, []);
});

test('two empty headings deduplicate the way a renderer does', () => {
  // The empty slug is a real slug, so a second empty heading takes the `-1`
  // suffix exactly like any other repeat. Measured against mdcheck's own output
  // on a document of `#\n\n#\n`: before the fix both headings were dropped and a
  // link to `#-1` was reported dangling, even though github.com renders
  // id="" and id="-1".
  const { Slugger } = require('../src/slug.js');
  const slugger = new Slugger();
  const anchors = ['#\n', '#\n']
    .map((source) => extract(source).headings)
    .flat()
    .map((h) => slugger.slug(h.text));
  assert.deepStrictEqual(anchors, ['', '-1']);

  // A heading whose text strips to empty -- "# ***" -- is the same case and
  // must behave identically.
  const stripped = new Slugger();
  const both = extract('# ***\n\n#\n').headings.map((h) => stripped.slug(h.text));
  assert.deepStrictEqual(both, ['', '-1']);
});

test('FenceTracker is a reusable state machine', () => {
  const fence = new FenceTracker();
  assert.strictEqual(fence.isFenced('```', 1), true);
  assert.strictEqual(fence.isFenced('body', 2), true);
  assert.strictEqual(fence.isFenced('```', 3), true);
  assert.strictEqual(fence.isFenced('body', 4), false);
  assert.strictEqual(fence.finish(), null);
});

test('parseTarget splits file and anchor', () => {
  assert.deepStrictEqual(
    { file: parseTarget('a.md#b').file, anchor: parseTarget('a.md#b').anchor },
    { file: 'a.md', anchor: 'b' }
  );
  assert.strictEqual(parseTarget('#top').file, '');
  assert.strictEqual(parseTarget('#top').anchor, 'top');
  assert.strictEqual(parseTarget('#').anchor, '');
  assert.strictEqual(parseTarget('#').empty, false);
});

test('parseTarget percent-decodes anchors', () => {
  assert.strictEqual(parseTarget('a.md#caf%C3%A9').anchor, 'café');
  // A malformed escape is left as-is rather than throwing.
  assert.strictEqual(parseTarget('a.md#%zz').anchor, '%zz');
});

test('parseTarget classifies external and absolute targets', () => {
  assert.strictEqual(parseTarget('https://x.com').external, true);
  assert.strictEqual(parseTarget('mailto:a@b.com').external, true);
  assert.strictEqual(parseTarget('a.md').external, false);
  assert.strictEqual(parseTarget('/root.md').absolute, true);
  assert.strictEqual(parseTarget('root.md').absolute, false);
  assert.strictEqual(parseTarget('').empty, true);
});

test('parseDestinationAndTitle rejects trailing junk', () => {
  assert.strictEqual(parseDestinationAndTitle('a.md').ok, true);
  assert.strictEqual(parseDestinationAndTitle('a.md extra bits').ok, false);
});
