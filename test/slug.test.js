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
  // The emoji is removed but the SPACE after it is real: GitHub emits
  // "-launch" here, because a space becomes a hyphen unconditionally and
  // nothing trims the leading one afterwards.
  assert.strictEqual(slugify('\u{1F680} launch'), '-launch');
  // Verified against github.com rendering a heading of this name: the emoji is
  // in an astral plane, and GitHub's strip table removes the whole surrogate
  // range rather than keeping it as a symbol.
  assert.strictEqual(slugify('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} family'), '-family');
  // "½" is U+00BD, a Unicode Number, but GitHub's table strips it. A
  // /\p{N}/ property class would have kept it and produced the wrong anchor.
  assert.strictEqual(slugify('\u00BD half'), '-half');
});

test('slugify keeps non-ASCII letters', () => {
  assert.strictEqual(slugify('café naïve'), 'café-naïve');
  assert.strictEqual(slugify('你好 世界'), '你好-世界');
});

test('slugify turns each space into one hyphen, including runs', () => {
  assert.strictEqual(slugify('a  b'), 'a--b');
  // A TAB is not a space: GitHub's table strips it outright, so "a\tb" and "ab"
  // slug identically. Turning tabs into hyphens invented an anchor that does
  // not exist on github.com.
  assert.strictEqual(slugify('a\tb'), 'ab');
});

test('slugify keeps leading and trailing hyphens, because GitHub does', () => {
  // This is the regression that matters: `## `--json`` in a README produces the
  // anchor `#--json` on github.com. An earlier implementation trimmed edge
  // hyphens "to be friendly" and mdcheck then reported that perfectly valid
  // link as a broken anchor -- a false positive on working documentation.
  assert.strictEqual(slugify('--json'), '--json');
  assert.strictEqual(slugify('--diff'), '--diff');
  assert.strictEqual(slugify('  spaces  '), '--spaces--');
  assert.strictEqual(slugify('trailing-'), 'trailing-');
  assert.strictEqual(slugify('- leading dash'), '--leading-dash');
  assert.strictEqual(slugify('---'), '---');
  assert.strictEqual(slugify(''), '');
});

test('slugify handles headings that are only punctuation', () => {
  // Nothing is trimmed, so a punctuation-only heading keeps whatever hyphens it
  // contains instead of collapsing to the empty string.
  assert.strictEqual(slugify('?!?'), '');
  assert.strictEqual(slugify('...'), '');
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
  assert.strictEqual(slugger.slug('!!!'), '');
  assert.strictEqual(slugger.slug('!!!'), '-1');
  assert.strictEqual(slugger.slug('!!!'), '-2');
});

test('Slugger numbers a repeated punctuation-only heading without trimming', () => {
  // "---" is a real slug now, so three headings of it are "---", "----1",
  // "----2": github-slugger appends the suffix to the WHOLE slug, which for a
  // heading that ends in a hyphen reads as four hyphens in a row. That is what
  // github.com emits, so reproducing it is the whole point.
  const slugger = new Slugger();
  assert.strictEqual(slugger.slug('---'), '---');
  assert.strictEqual(slugger.slug('---'), '----1');
  assert.strictEqual(slugger.slug('---'), '----2');
});

test('stripInlineMarkup keeps intraword underscores, which GitHub renders literally', () => {
  // CommonMark's intraword rule: `_` between two word characters is not an
  // emphasis delimiter, so identifiers survive into the anchor. Deleting every
  // underscore made `# snake_case-kept` mismatch github.com's `snake_case-kept`.
  assert.strictEqual(stripInlineMarkup('snake_case-kept'), 'snake_case-kept');
  assert.strictEqual(slug('snake_case-kept'), 'snake_case-kept');
  assert.strictEqual(slug('max_length_2'), 'max_length_2');
  // Underscores that really are delimiters are still removed.
  assert.strictEqual(stripInlineMarkup('_em_'), 'em');
  assert.strictEqual(stripInlineMarkup('__strong__'), 'strong');
  // A leading underscore is NOT an opener either. The old regex
  // `(?<![A-Za-z0-9])_(?=\S)` matched one here -- there is no word character
  // in front -- so it deleted the `_` of `_a` and `# _a` slugged to `a` where
  // GitHub emits `_a`. markdown-it-py agrees the underscore is literal.
  assert.strictEqual(stripInlineMarkup('_a'), '_a');
  assert.strictEqual(slug('_a'), '_a');
  assert.strictEqual(stripInlineMarkup('_private_field'), '_private_field');
  assert.strictEqual(slug('_private_field'), '_private_field');
  assert.strictEqual(stripInlineMarkup('a_'), 'a_');
});

test('an unmatched delimiter stays literal, because it renders literal', () => {
  // Every expectation below is what markdown-it-py renders, verified one by one
  // rather than guessed. `__strong__tail` does NOT become `strongtail`: the
  // closing `__` is followed by `t`, so it is not right-flanking and cannot
  // close anything. The previous version of this file asserted `strongtail`,
  // which was simply the wrong expectation -- mdcheck was reporting a working
  // anchor as broken.
  assert.strictEqual(stripInlineMarkup('__strong__tail'), '__strong__tail');
  assert.strictEqual(stripInlineMarkup('__a__b'), '__a__b');
  assert.strictEqual(stripInlineMarkup('_'), '_');
  assert.strictEqual(stripInlineMarkup('__'), '__');
  assert.strictEqual(stripInlineMarkup('___'), '___');
  assert.strictEqual(stripInlineMarkup('_leading underscore'), '_leading underscore');
  assert.strictEqual(stripInlineMarkup('trailing_'), 'trailing_');
  // A `*` needs a partner too, and here the run is followed by whitespace, so
  // it cannot open.
  assert.strictEqual(stripInlineMarkup('* star *'), '* star *');
  // Nesting: the inner `_` pair matches, the outer ones cannot because the
  // text between them is what is left.
  assert.strictEqual(stripInlineMarkup('_a_b_'), 'a_b');
  assert.strictEqual(stripInlineMarkup('_under_score_ mixed'), 'under_score mixed');
  assert.strictEqual(stripInlineMarkup('a _b_ c'), 'a b c');
  assert.strictEqual(stripInlineMarkup('**bold** and __also__'), 'bold and also');
  assert.strictEqual(stripInlineMarkup('***both***'), 'both');
  assert.strictEqual(stripInlineMarkup('~~struck~~'), 'struck');
});

test('an escaped backtick cannot OPEN a code span but still CLOSES one', () => {
  // The asymmetry is the renderer's, verified against markdown-it-py's tokens
  // rather than reasoned about: the inline tokenizer runs the escape rule first,
  // so `\`` never becomes a delimiter opener -- but the closer search is a raw
  // `indexOf('`')` over the source with no escape handling at all.
  //
  // Opener side: in `` \`a` `` the escaped backtick is literal, and the second,
  // unescaped backtick has nothing to close, so it is literal too. markdown-it
  // renders `` `a` `` -- both backticks survive.
  assert.strictEqual(stripInlineMarkup('\\`a`'), '`a`');
  // Opener side, the case that mattered: pairing the escaped backtick with the
  // later unrelated one would swallow `a` into a code span and delete it.
  assert.strictEqual(stripInlineMarkup('\\`~~< x `'), '`~~< x `');
  // Closer side: in `` `a\`b` `` the escaped backtick IS the closer, so the
  // span is `a\` and the trailing `b\`` stays literal text.
  assert.strictEqual(stripInlineMarkup('`a\\`b`'), 'a\\b`');
  assert.strictEqual(stripInlineMarkup('`a\\`'), 'a\\');
  // An escaped backslash is not a shield either: `` `a\\` `` closes normally.
  assert.strictEqual(stripInlineMarkup('`a\\\\`'), 'a\\\\');
  // This one lost an underscore before the closer search stopped honouring
  // escapes: mdcheck emitted `_a-_` where the renderer emits `_a ___,\,>`.
  // The trailing `_` is emphasis there (it closes the `_` opened before the
  // backtick), which is exactly why losing the closer cost a real character.
  assert.strictEqual(stripInlineMarkup('\\_a _`___,\\`,>_'), '_a ___,\\,' + '>');
  assert.strictEqual(slug('\\_a _`___,\\`,>_'), '_a-___');
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
