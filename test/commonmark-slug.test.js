'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { slug, stripInlineMarkup, Slugger } = require('../src/slug.js');
const { NAMED_ENTITIES } = require('../src/entities.js');

// Every expectation below was taken from a CommonMark-compliant renderer
// (markdown-it-py) rather than from mdcheck's own behaviour, so these tests
// fail if the implementation drifts from the renderer -- which is the whole
// point: an anchor mdcheck accepts must be the anchor github.com emits.

test('stripInlineMarkup decodes HTML5 entity references', () => {
  // The bug this pins: `A &amp; B` renders as `A & B`, so the anchor GitHub
  // generates is `#a--b`. Left as source it slugged to `a-amp-b`, and mdcheck
  // reported a working anchor as dangling.
  assert.strictEqual(stripInlineMarkup('A &amp; B'), 'A & B');
  assert.strictEqual(slug('A &amp; B'), 'a--b');
  assert.strictEqual(stripInlineMarkup('AT&T'), 'AT&T');
  assert.strictEqual(stripInlineMarkup('a &copy; b'), 'a © b');
  assert.strictEqual(stripInlineMarkup('x&nbsp;y'), 'x\xa0y');
  assert.strictEqual(stripInlineMarkup('&lt;tag&gt;'), '<tag>');
  assert.strictEqual(stripInlineMarkup('quote &quot;q&quot;'), 'quote "q"');
  // Numeric references, decimal and hexadecimal.
  assert.strictEqual(stripInlineMarkup('&#65;&#x42;'), 'AB');
  assert.strictEqual(stripInlineMarkup('&#x2019;'), '’');
  assert.strictEqual(stripInlineMarkup('&#38;&#x26;'), '&&');
});

test('stripInlineMarkup requires the semicolon on a named reference', () => {
  // CommonMark does not recognise the HTML5 semicolonless legacy forms, and
  // decoding them anyway would invent an anchor that does not exist.
  assert.strictEqual(stripInlineMarkup('A &amp B'), 'A &amp B');
  assert.strictEqual(stripInlineMarkup('&ampx'), '&ampx');
  assert.strictEqual(stripInlineMarkup('&notanentity;'), '&notanentity;');
  // ...but the name is still case sensitive, as in the standard.
  assert.strictEqual(stripInlineMarkup('&AMP;'), '&');
});

test('an entity-produced tag is TEXT, not markup', () => {
  // `&lt;b&gt;x&lt;/b&gt;` renders as the literal characters `<b>x</b>`. Decoding
  // it before the tag stripper would hand that stripper a real `<b>` and it
  // would then delete text the reader sees.
  assert.strictEqual(stripInlineMarkup('&lt;b&gt;x&lt;/b&gt;'), '<b>x</b>');
  assert.strictEqual(stripInlineMarkup('&lt;https://x.io&gt;'), '<https://x.io>');
});

test('out-of-range numeric references become U+FFFD', () => {
  // The HTML5 parsing rules: 0, anything above U+10FFFF and surrogates are
  // parse errors.
  assert.strictEqual(stripInlineMarkup('&#0;'), '�');
  assert.strictEqual(stripInlineMarkup('&#xD800;'), '�');
  assert.strictEqual(stripInlineMarkup('&#1114112;'), '�');
});

test('stripInlineMarkup keeps an autolink as its URL text', () => {
  // Previously the HTML-tag pattern matched the whole `<...>` and deleted it,
  // so a heading built around an autolink lost its anchor text entirely.
  assert.strictEqual(stripInlineMarkup('<https://example.com>'), 'https://example.com');
  assert.strictEqual(stripInlineMarkup('auto <https://x.io> after'), 'auto https://x.io after');
  assert.strictEqual(stripInlineMarkup('<mailto:a@b.co>'), 'mailto:a@b.co');
  assert.strictEqual(stripInlineMarkup('<a@b.co>'), 'a@b.co');
  // A two-character scheme is the minimum: `<a:b>` is not an autolink.
  assert.strictEqual(stripInlineMarkup('<ab:c>'), 'ab:c');
  assert.strictEqual(stripInlineMarkup('<a:b>'), '<a:b>');
  // Whitespace cannot appear in the destination.
  assert.strictEqual(stripInlineMarkup('<https://a/ b>'), '<https://a/ b>');
});

test('an autolink inside a code span is literal text, not a link', () => {
  assert.strictEqual(stripInlineMarkup('`<https://x.io>`'), '<https://x.io>');
});

test('stripInlineMarkup removes HTML comments', () => {
  assert.strictEqual(stripInlineMarkup('x<!-- c -->y'), 'xy');
  assert.strictEqual(stripInlineMarkup('<!-- only comment -->'), '');
  // The bare forms ARE comments...
  assert.strictEqual(stripInlineMarkup('a<!-->b'), 'ab');
  assert.strictEqual(stripInlineMarkup('a<!--->b'), 'ab');
  assert.strictEqual(stripInlineMarkup('<!---->'), '');
  // ...but this one is not: a comment may not end with `--` after its text.
  assert.strictEqual(stripInlineMarkup('<!----->'), '<!----->');
  // An unterminated comment is literal text, not a comment.
  assert.strictEqual(stripInlineMarkup('a<!-- b'), 'a<!-- b');
  assert.strictEqual(stripInlineMarkup('<!-- >'), '<!-- >');
});

test('stripInlineMarkup drops only well-formed HTML tags', () => {
  assert.strictEqual(stripInlineMarkup('<b>bold</b>'), 'bold');
  assert.strictEqual(stripInlineMarkup('<br/>'), '');
  assert.strictEqual(stripInlineMarkup('<span class="a">y</span>'), 'y');
  assert.strictEqual(stripInlineMarkup('<img src="x" alt="y">'), '');
  // Tag names may contain a hyphen but not a dot, a colon or an equals sign;
  // CommonMark leaves those as literal text.
  assert.strictEqual(stripInlineMarkup('<a-b>'), '');
  assert.strictEqual(stripInlineMarkup('<a.b>'), '<a.b>');
  assert.strictEqual(stripInlineMarkup('<a=b>'), '<a=b>');
  assert.strictEqual(stripInlineMarkup('<a"b">'), '<a"b">');
  assert.strictEqual(stripInlineMarkup("5 < 6 and 7 > 8"), '5 < 6 and 7 > 8');
});

test('a code span loses one space at each end, per CommonMark', () => {
  // ``` `` a ` b `` ``` renders as `a ` b`: the spec removes one leading and
  // one trailing space when BOTH are present and the content is not all spaces.
  assert.strictEqual(stripInlineMarkup('`` a ` b ``'), 'a ` b');
  assert.strictEqual(stripInlineMarkup('` a `'), 'a');
  assert.strictEqual(stripInlineMarkup('`  a  `'), ' a ');
  // Only one end padded: nothing is stripped.
  assert.strictEqual(stripInlineMarkup('` a`'), ' a');
  assert.strictEqual(stripInlineMarkup('`a `'), 'a ');
  // All spaces: kept as they are.
  assert.strictEqual(stripInlineMarkup('` `'), ' ');
  assert.strictEqual(stripInlineMarkup('`   `'), '   ');
  // A tab at the edge is content, not the padding the rule describes.
  assert.strictEqual(stripInlineMarkup('`\ta\t`'), '\ta\t');
});

test('the entity table is the HTML5 one, semicolon-terminated only', () => {
  assert.strictEqual(NAMED_ENTITIES.size, 2125);
  assert.ok(NAMED_ENTITIES.has('amp'));
  assert.ok(NAMED_ENTITIES.has('copy'));
  // HTML5 defines semicolonless forms that CommonMark does NOT recognise, so
  // the generated table must not contain them.
  for (const key of NAMED_ENTITIES.keys()) {
    assert.ok(!key.endsWith(';'), `table key must not include the semicolon: ${key}`);
  }
  // Legacy multi-character expansions survive as written.
  assert.deepStrictEqual(NAMED_ENTITIES.get('bne'), [0x3d, 0x20e5]);
});

test('fixed point: decoding entities twice is stable', () => {
  // `&amp;lt;` renders as the TEXT `&lt;`, not as `<`: the decoder runs once,
  // before anything restores protected text, so it cannot cascade. The slug is
  // "lt" because GitHub's strip table removes `&` and `;` and leaves "lt".
  assert.strictEqual(stripInlineMarkup('&amp;lt;'), '&lt;');
  assert.strictEqual(slug('&amp;lt;'), 'lt');
  assert.strictEqual(stripInlineMarkup('&amp;amp;'), '&amp;');
});

test('anchors built from the fixed constructs resolve as GitHub does', () => {
  const s = new Slugger();
  assert.strictEqual(s.slug('A &amp; B'), 'a--b');
  assert.strictEqual(s.slug('A &amp; B'), 'a--b-1');
  // The URL's own `:` and `.` are stripped by GitHub's table, and no space ever
  // appears, so there is no hyphen.
  assert.strictEqual(s.slug('<https://example.com>'), 'httpsexamplecom');
  assert.strictEqual(s.slug('x<!-- c -->y'), 'xy');
});