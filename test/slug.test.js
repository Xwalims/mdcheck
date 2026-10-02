'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { slugify, slug, stripInlineMarkup, normalizeLabel, Slugger } = require('../src/slug.js');

test('slugify lowercases and hyphenates spaces', () => {
  assert.strictEqual(slugify('Hello World'), 'hello-world');
  assert.strictEqual(slugify('API Reference'), 'api-reference');
});

test('slugify strips punctuation but keeps hyphens and underscores', () => {
  assert.strictEqual(slugify('Hello, World!'), 'hello-world');
  assert.strictEqual(slugify('snake_case-kept'), 'snake_case-kept');
  assert.strictEqual(slugify('What? Why! How.'), 'what-why-how');
  assert.strictEqual(slugify('e.g. $5.00'), 'eg-500');
  assert.strictEqual(slugify("it's a trap"), 'its-a-trap');
});

test('slugify strips symbols and emoji entirely', () => {
  assert.strictEqual(slugify('C++ & C#'), 'c--c');
  assert.strictEqual(slugify('100% done'), '100-done');
  assert.strictEqual(slugify('v1.2.3 release'), 'v123-release');
  assert.strictEqual(slugify('🚀 launch'), 'launch');
});

test('slugify keeps non-ASCII letters', () => {
  assert.strictEqual(slugify('café naïve'), 'café-naïve');
  assert.strictEqual(slugify('你好 世界'), '你好-世界');
});

test('slugify turns each space into one hyphen, including runs', () => {
  assert.strictEqual(slugify('a  b'), 'a--b');
  assert.strictEqual(slugify('a\tb'), 'a-b');
});

test('slugify drops leading and trailing hyphens', () => {
  assert.strictEqual(slugify('  spaces  '), 'spaces');
  assert.strictEqual(slugify('trailing-'), 'trailing');
  assert.strictEqual(slugify('---'), '');
  assert.strictEqual(slugify(''), '');
});

test('slugify is idempotent for its own output', () => {
  for (const input of ['Hello, World!', 'C++ & C#', 'café naïve', '---']) {
    const once = slugify(input);
    assert.strictEqual(slugify(once), once, `not idempotent: ${JSON.stringify(input)}`);
  }
});

test('stripInlineMarkup keeps the text content of links and code spans', () => {
  // GitHub slugs a heading's text content, so only delimiters are removed.
  assert.strictEqual(stripInlineMarkup('[text](url)'), 'text');
  assert.strictEqual(stripInlineMarkup('**bold**'), 'bold');
  assert.strictEqual(stripInlineMarkup('*em*'), 'em');
  assert.strictEqual(stripInlineMarkup('~~gone~~'), 'gone');
  assert.strictEqual(stripInlineMarkup('`code`'), 'code');
  assert.strictEqual(stripInlineMarkup('![alt](x.png)'), 'alt');
  assert.strictEqual(stripInlineMarkup('![](x.png)'), '');
  assert.strictEqual(stripInlineMarkup('<b>bold</b>'), 'bold');
});

test('stripInlineMarkup honours backslash escapes', () => {
  // The escaped asterisks are literal text, so they survive the emphasis
  // stripper and are then deleted as punctuation by the slug step.
  assert.strictEqual(stripInlineMarkup('A \\*b\\* c'), 'A *b* c');
  assert.strictEqual(slug('A \\*b\\* c'), 'a-b-c');
  // An escaped underscore is not an emphasis delimiter.
  assert.strictEqual(stripInlineMarkup('\\_literal\\_'), '_literal_');
});

test('slug strips markup then slugifies', () => {
  assert.strictEqual(slug('The **bold** part'), 'the-bold-part');
  assert.strictEqual(slug('See [the docs](http://x)'), 'see-the-docs');
  assert.strictEqual(slug('Using `<code>` here'), 'using-code-here');
});

test('Slugger numbers duplicate headings in document order', () => {
  const slugger = new Slugger();
  assert.strictEqual(slugger.slug('Usage'), 'usage');
  assert.strictEqual(slugger.slug('Usage'), 'usage-1');
  assert.strictEqual(slugger.slug('Usage'), 'usage-2');
  assert.strictEqual(slugger.slug('Other'), 'other');
});

test('Slugger skips a suffixed slug that a literal heading already took', () => {
  // github-slugger dedupes with a loop, not a counter: the literal "Foo-1"
  // must not be handed out twice.
  const slugger = new Slugger();
  assert.strictEqual(slugger.slug('Foo'), 'foo');
  assert.strictEqual(slugger.slug('Foo-1'), 'foo-1');
  assert.strictEqual(slugger.slug('Foo'), 'foo-2');
  assert.strictEqual(slugger.slug('Foo'), 'foo-3');
});

test('Slugger treats differing case and punctuation as the same slug', () => {
  const slugger = new Slugger();
  assert.strictEqual(slugger.slug('Setup'), 'setup');
  assert.strictEqual(slugger.slug('SETUP!'), 'setup-1');
  assert.strictEqual(slugger.slug('set up'), 'set-up');
});

test('Slugger dedupes the empty slug the way github-slugger does', () => {
  // A heading of only punctuation slugifies to "". github-slugger's dedup loop
  // then produces "" , "-1", "-2" -- the leading hyphen is part of the suffix,
  // not trimmed. mdcheck reproduces that rather than inventing a friendlier
  // rule, because the anchors have to match what GitHub generates.
  const slugger = new Slugger();
  assert.strictEqual(slugger.slug('---'), '');
  assert.strictEqual(slugger.slug('!!!'), '-1');
  assert.strictEqual(slugger.slug('?!?'), '-2');
});

test('Slugger.list returns slugs in document order', () => {
  const slugger = new Slugger();
  for (const h of ['A', 'B', 'A', 'C']) slugger.slug(h);
  assert.deepStrictEqual(slugger.list(), ['a', 'b', 'a-1', 'c']);
});

test('normalizeLabel trims, collapses whitespace and lowercases', () => {
  assert.strictEqual(normalizeLabel('  My  Ref '), 'my ref');
  assert.strictEqual(normalizeLabel('MiXeD Case'), 'mixed case');
});
