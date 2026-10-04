# mdcheck

A markdown link and anchor checker for local files. Zero dependencies, no
network, no config file.

mdcheck reads your markdown, works out where every link points, and tells you
which ones lead nowhere -- including `#anchors` that no longer exist because
somebody renamed a heading.

```sh
git clone https://github.com/Xwalims/mdcheck.git && cd mdcheck
node bin/mdcheck.js README.md docs/
```

```
✔ no problems in 3 files (5 links checked, 1 external link skipped)
```

<!-- hero -->

[![CI](https://github.com/Xwalims/mdcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwalims/mdcheck/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [What it catches](#what-it-catches)
- [Exit codes](#exit-codes)
- [What counts as a problem](#what-counts-as-a-problem)
  - [Counts tally every code, whatever it is called](#counts-tally-every-code-whatever-it-is-called)
  - [Directory links](#directory-links)
- [Limitations](#limitations)
- [License](#license)

<!-- /hero -->

## Why

Broken links in a README are the kind of bug that ships, because nobody reads
the README after the first commit. The usual tools fetch every URL over the
network, which is slow, flaky in CI, and blind to the links that matter most:
the ones pointing at files *in your repo*.

mdcheck takes the offline half of the problem seriously:

- **No network, ever.** External links are skipped and counted, not fetched.
  Your CI stays fast and works offline.
- **Anchors are GitHub's anchors.** mdcheck reimplements GitHub's heading-slug
  algorithm exactly, so `#usage-1` means the same thing here as on github.com.
- **Code is not prose.** A link inside a fenced block or a code span is not a
  link, and mdcheck never reports one.

## Install

This package is **not published to npm** — that name belongs to an unrelated link
checker. Run it from a checkout:

```sh
git clone https://github.com/Xwalims/mdcheck.git
cd mdcheck
node bin/mdcheck.js README.md docs/
```

Or link it into the project you want to check:

```sh
npm link          # provides the `mdcheck` command
```

Node 20 or newer. Nothing else.

## Usage

```
mdcheck [paths...] [options]
```

Paths may be files or directories; directories are walked recursively for
markdown. With no paths, the current directory is checked.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--json` | off | print a machine-readable JSON report |
| `--no-color` | off | never emit ANSI color |
| `--ext <list>` | `.md,.markdown` | extensions treated as markdown |
| `--check-external` | off | also check external links (shape only) |
| `--index-file <list>` | `README.md,index.md` | filenames that make a directory link valid |
| `--follow-root-absolute` | off | resolve a leading `/` from the current directory instead of the filesystem root |
| `--quiet` | off | print problems only, no summary |
| `--strict` | off | treat warnings as failures |
| `-h`, `--help` | | show usage |
| `-v`, `--version` | | print the version |

## What it catches

Here is `mdcheck examples/` running against a real, deliberately broken file.
This is the actual output, not an illustration:

```
examples/broken.md
  examples/broken.md:9:1  file-not-found  error  no file at "does-not-exist.md" (relative to examples/broken.md); use a relative path from the current file, or add --follow-root-absolute if this is a site
      target: does-not-exist.md
  examples/broken.md:13:12  anchor-not-found  error  no heading in ../docs/codes.md produces #no-such-heading; anchors come from heading text: lowercase, punctuation dropped, spaces to hyphens
      target: #no-such-heading
  examples/broken.md:17:1  empty-target  error  link has no destination; use the page URL for a self link, or "#" for the top of the current document
  examples/broken.md:21:1  absolute-path  warning  "/etc/passwd" starts with "/" and resolves from the filesystem root
      target: /etc/passwd
  examples/broken.md:52:1  unresolved-reference  error  no [text]: definition in this file; reference definitions are file-scoped and are not shared between files
      target: [text]

5 problems in 1 file
1 absolute-path, 1 anchor-not-found, 1 empty-target, 1 file-not-found, 1 unresolved-reference

1 external link skipped (pass --check-external to check them)
```

Note what is *absent*: the broken links inside the fenced and inline code in
that same file. They are code samples, not links, and mdcheck knows the
difference.

Every code has a page: [docs/codes.md](docs/codes.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | No errors. Warnings may have been printed. |
| 1 | At least one error. |
| 2 | Usage error: unknown flag, or missing option value. |

This makes the obvious CI invocation work:

```sh
mdcheck README.md docs/ || exit 1
```

## What counts as a problem

| Written as | Result |
| --- | --- |
| `[a](docs/b.md)` | `docs/b.md` must exist, relative to this file |
| `[a](docs/b.md#usage)` | `docs/b.md` must exist *and* have a heading producing `#usage` |
| `[a](#usage)` | the current file must have that heading |
| `[a](#)` | the top of the current file. Always valid |
| `[a](docs)` | `docs/` must contain `README.md` or `index.md` |
| `[a](/docs/b.md)` | a **warning**: absolute paths only work on a site served from `/` |
| `[a](b.md "Title")` | the title is stripped; `b.md` is checked |
| `<https://example.com>` | skipped, and counted, unless `--check-external` |
| `[a][ref]` + `[ref]: b.md` | resolved through the definition, then checked |
| `` `[a](b.md)` `` | code, not a link. Never reported |

Anchors are compared **case-insensitively** and after percent-decoding, because
renderers differ on that and a false positive teaches people to ignore mdcheck.

### Counts tally every code, whatever it is called

`report.counts` is keyed by diagnostic code, so a code that happens to share a
name with a member of `Object.prototype` must still count like any other. It
does:

```js
// counts for codes ['file-not-found', '__proto__', 'file-not-found',
//                   'constructor', 'toString', 'file-not-found']
{
  "file-not-found": 3,
  "__proto__": 1,
  "constructor": 1,
  "toString": 1
}
```

```
6 problems in 0 files
3 file-not-found, 1 __proto__, 1 constructor, 1 toString
```

`sum(counts)` equals `totals.problems`, every entry is a `number`, and
`__proto__` is an own key rather than a prototype swap.

Worth knowing why this is not automatic: the obvious tally is
`counts[code] = (counts[code] ?? 0) + 1`, and that read walks the prototype
chain. For `constructor` it returns a function, `?? 0` never fires, and the map
ends up holding the string `"function Object() { [native code] }1"` where a
count belongs. For `__proto__` it returns `Object.prototype` itself, so `{} + 1`
is the string `"[object Object]1"` and that string gets assigned as the
prototype -- the count vanishes with no error to notice. Both shipped at some
point. The tally now tests for an *own* key and writes through a define, which
is what `JSON.parse` does with the same name.

### Directory links

A link to a directory is not a file. GitHub resolves it by serving that
directory's `README.md`, so mdcheck requires one of the files in
`--index-file` (default `README.md`, `index.md`) to be present. Point it at your
own landing page with `mdcheck docs/ --index-file landing.md`.

### External links

mdcheck never opens a socket. `--check-external` does not fetch URLs -- it checks
the failure modes that are visible offline, such as `https://` with no host and
a URL with a trailing space. For real network checking, reach for
`lychee` or `linkchecker`; mdcheck will not turn your test suite into an
integration test.

## Library API

```js
const { checkFile, checkPaths } = require('mdcheck');

// One file.
const report = checkFile('README.md');

// A directory, with options.
const wide = checkPaths(['docs/'], {
  indexFiles: ['README.md', 'index.md'],
  checkExternal: false,
});

if (!wide.ok) {
  for (const p of wide.problems) {
    console.log(`${p.file}:${p.line}:${p.column} ${p.code} ${p.message}`);
  }
}
```

The report object:

```js
{
  files:    [{ file: 'README.md', problems: 0 }],
  problems: [{ file, line, column, code, target, message, severity }],
  counts:   { 'file-not-found': 3 },
  totals:   { files: 12, problems: 3, links: 48, skippedExternal: 7 },
  ok:       false
}
```

Also exported: `DEFAULT_OPTIONS` (frozen, the single source of every default),
`CODES`, `EXIT`, `resolveOptions`, `normalizeExtensions`, `normalizeIndexFiles`.

### JSON output

`--json` prints the same object, so a script can consume it directly:

```
$ mdcheck examples/ --json
{
  "files": [
    {
      "file": "examples/broken.md",
      "problems": 5
    }
  ],
  "problems": [
    {
      "file": "examples/broken.md",
      "line": 9,
      "column": 1,
      "code": "file-not-found",
      "target": "does-not-exist.md",
      "message": "no file at \"does-not-exist.md\" (relative to examples/broken.md); use a relative path from the current file, or add --follow-root-absolute if this is a site",
      "severity": "error"
    },
```

## How anchors are computed

Getting this wrong is the most common way a link checker produces false
positives, so mdcheck uses GitHub's algorithm rather than approximating it. For
the heading `## Hello, World! (v2)`:

1. Strip inline markup, keeping the *text* of links, code spans and images.
2. Lowercase: `hello, world! (v2)`.
3. Drop every character in GitHub's strip table: `hello world v2`.
4. Turn spaces into hyphens: `hello-world-v2`.
5. Nothing is trimmed.
6. If that slug is taken, append `-1`, then `-2`, in document order.

The strip table in step 3 is copied verbatim from
[github-slugger](https://github.com/Flet/github-slugger) (MIT), not derived from
Unicode property classes, and that distinction is load-bearing. A plausible
`/[^\p{L}\p{N}\p{M}_\- ]/gv` disagrees with GitHub on real input in both
directions:

| Heading | GitHub | A `\p{N}` property class |
| ------- | ------ | ------------------------- |
| `# ½ half` | `-half` | `½-half` |
| `# 🚀 launch` | `-launch` | `-launch` |
| `# a\tb` | `ab` | `a-b` |

Step 5 is the one people expect to differ, and it does not. GitHub trims
nothing, so a heading made of hyphens keeps them:

```md
## `--json`
```

is the anchor `#--json` -- and it is a perfectly valid link. mdcheck used to
trim those hyphens as a courtesy, which made it report that working link as
broken. It now matches GitHub on all 186 headings in this batch.

Non-ASCII letters survive: `# café naïve` becomes `café-naïve`, not
`caf-naive`. An intraword underscore is not emphasis, so `# snake_case` is
`snake_case`, per CommonMark. Duplicates get github-slugger's exact numbering,
including the subtle case where a literal `Foo-1` heading forces the second
`Foo` to become `foo-2` rather than colliding.

## Development

```sh
node --test                        # the whole suite, no dependencies
node bin/mdcheck.js README.md docs/   # mdcheck on its own docs
node bin/mdcheck.js examples/      # expected to fail; that is the fixture
```

The suite covers the slug algorithm, link extraction, code-fence and code-span
handling, every validation rule, and the CLI end to end -- the e2e tests spawn
the real `bin/mdcheck.js` and assert real exit codes.

Layout:

```
bin/mdcheck.js     executable entry point; assigns the exit code
src/slug.js        GitHub's heading-anchor algorithm
src/github-slug-regex.js
                   GitHub's character-strip table, copied verbatim from
                   github-slugger (MIT); generated there from Unicode data
src/links.js       markdown link extraction, no parser
src/index.js       validation rules and the library API
src/report.js      diagnostic codes and the two renderers
src/cli.js         argument parsing
docs/              configuration and code reference
examples/          deliberately broken markdown, used as a fixture
```

## Limitations

Worth knowing up front:

- It is a line scanner, not a CommonMark parser. It is right about where links
  point and wrong about exotic inline nesting; it never tries to be a renderer.
- Headings are recognized in both ATX (`## Title`) and setext (`Title` underlined
  by `===` or `---`) form. The setext rule follows cmark-gfm: an underline only
  becomes a heading when a paragraph is open above it, so `---` after a blank
  line or after an ATX heading stays a thematic break.
- External URLs are checked for shape, never fetched.
- Reference definitions are file-scoped, as in CommonMark.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Xwalims.
