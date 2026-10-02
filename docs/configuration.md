# Configuration

mdcheck has no config file. Everything is either a flag or a library option,
and every default lives in one frozen object (`DEFAULT_OPTIONS` in
`src/index.js`) so there is a single place to look when you wonder where a
number came from.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--json` | off | print a machine-readable JSON report instead of text |
| `--no-color` | off | never emit ANSI color |
| `--ext <list>` | `.md,.markdown` | file extensions treated as markdown when walking a directory |
| `--check-external` | off | also check external links (shape only, never a network call) |
| `--index-file <list>` | `README.md,index.md` | filenames that make a directory link valid |
| `--quiet` | off | print problems only, no summary |
| `--strict` | off | treat warnings as failures |
| `-h`, `--help` | | show usage |
| `-v`, `--version` | | print the version |

## Library options

`checkFile(path, options)` and `checkPaths(paths, options)` take the same
options, without the CLI's spelling:

```js
const { checkPaths } = require('mdcheck');

const report = checkPaths(['docs/'], {
  extensions: ['.md', '.markdown'],
  indexFiles: ['README.md', 'index.md'],
  checkExternal: false,
  followRootAbsolute: false,
});

if (!report.ok) {
  for (const problem of report.problems) {
    console.log(`${problem.file}:${problem.line}:${problem.column} ${problem.code}`);
  }
}
```

## Anchors are compared case-insensitively

GitHub lowercases every anchor, and some renderers percent-decode them before
comparing. mdcheck does the same: it slugifies the target document's headings,
lowercases both sides, and compares. That makes `[see](#Usage)` and
`[see](#usage)` equivalent, and lets `(#caf%C3%A9)` match `# Café`.

## Why a directory link needs an index file

A link to a directory (`[docs](docs)`) is not a file on disk. GitHub resolves it
by serving that directory's `README.md`. mdcheck applies the same rule: the
directory must contain one of the files in `--index-file`, which defaults to
`README.md` and `index.md`.

This is a deliberate design choice and the one rule that is configurable rather
than universal, because "what does a directory link mean" is genuinely
site-specific. Point a docs site at its own landing page with:

```sh
mdcheck docs/ --index-file landing.md
```

## Absolute paths are a warning, not an error

A link starting with `/` resolves from the filesystem root. That is correct on a
site served from `/`, and broken everywhere else -- it 404s on GitHub, and
`file://` resolves it against your disk's root. mdcheck reports it as a warning
so it is visible but does not fail a build:

```
docs/a.md:8:1  absolute-path  warning  "/etc/passwd" starts with "/" and resolves from the filesystem root
```

Two ways to handle it:

- **Prefer relative links.** They work on GitHub, on a local file server, and on
  a static site. mdcheck exits 0 with only this warning.
- **Site sources.** If you are checking a site that really is served from `/`,
  resolve those links instead of warning:

  ```sh
  mdcheck src/ --follow-root-absolute
  ```

  Or, to make the portability concern matter, fail on it:

  ```sh
  mdcheck . --strict
  ```

## Color

Color is off when stdout is not a TTY, and follows the
[no-color.org](https://no-color.org) conventions:

- `NO_COLOR` set to any non-empty value disables color.
- `FORCE_COLOR` set to anything but `0` enables it.
- `--no-color` always wins.

This means piping mdcheck into a file, a pager or another program gives you
clean text by default, with no flag needed.
