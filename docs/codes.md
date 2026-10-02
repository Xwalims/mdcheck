# Diagnostic codes

Every problem mdcheck reports has a `code`. The codes are stable: new ones may
be added, existing ones will not change meaning.

| Code | Severity | What it means |
| --- | --- | --- |
| `file-not-found` | error | The link's file part does not exist, or is a directory with no index file |
| `anchor-not-found` | error | No heading in the target document produces that anchor |
| `empty-target` | error | The link has no destination: `[text]()` |
| `malformed-link` | error | The link syntax itself is invalid, e.g. an unclosed `(` |
| `unclosed-code-fence` | error | A fence opens and never closes, hiding the rest of the file |
| `trailing-whitespace-in-url` | error | The URL ends in a space or tab, so it will not resolve |
| `unresolved-reference` | error | `[text][id]` has no matching `[id]:` definition in the file |
| `absolute-path` | warning | The link starts with `/` and will not work off a site root |

## file-not-found

The target file does not exist on disk, relative to the linking document.

```
docs/a.md:4:1  file-not-found  error  no file at "missing.md" (relative to docs/a.md); use a relative path from the current file, or add --follow-root-absolute if this is a site
```

The same code covers a directory link with no index file, because the practical
symptom is identical -- the link resolves to nothing:

```
docs/a.md:9:1  file-not-found  error  directory "sub" contains none of README.md, index.md
```

Change the list with `--index-file`; see
[Configuration](configuration.md#why-a-directory-link-needs-an-index-file).

## anchor-not-found

The target file exists, but no heading in it produces the anchor you asked for.
Anchors come from heading text: lowercased, punctuation dropped, spaces turned
into hyphens, with duplicates numbered `-1`, `-2`, ...

```
docs/a.md:5:1  anchor-not-found  error  no heading in target.md produces #nope; anchors come from heading text: lowercase, punctuation dropped, spaces to hyphens
```

This is the code that catches renames. Rename a heading, and every link to its
old anchor fails here.

## empty-target

`[text]()` points nowhere.

```
docs/a.md:7:1  empty-target  error  link has no destination; use the page URL for a self link, or "#" for the top of the current document
```

For a link to the top of the same page, write `[top](#)`.

## malformed-link

The link syntax does not close. The most common cause is a missing `)`.

```
docs/a.md:11:1  malformed-link  error  link destination is missing a closing ")": [unclosed](docs/e.md
```

If a destination needs to contain a space, wrap it in angle brackets:
`[a](<my file.md>)`.

## unclosed-code-fence

A fence opens and never closes, so mdcheck cannot tell code from prose after it.

```
docs/a.md:3:1  unclosed-code-fence  error  code fence opened here is never closed, so the rest of the file is skipped; close the fence with the same number of backticks or tildes
```

This is worth reporting rather than guessing: once a fence is open, every
remaining link in the file is invisible, and a file full of apparently clean
links may simply have stopped being checked.

## trailing-whitespace-in-url

The destination ends in whitespace. Markdown keeps that space, so the URL no
longer resolves.

```
docs/a.md:14:1  trailing-whitespace-in-url  error  URL ends with whitespace: "b.md "
```

The fix is to delete the space. If the space is genuinely part of the filename,
use angle brackets so the renderer keeps it deliberately.

## unresolved-reference

`[text][id]` has no `[id]:` definition. Reference definitions are file-scoped
and are not shared between files.

```
docs/a.md:3:1  unresolved-reference  error  no [ref]: definition in this file; reference definitions are file-scoped and are not shared between files
```

A shortcut reference like `[ref]` with no definition is *not* reported. Bare
square brackets are ordinary text far more often than they are links, so mdcheck
only treats `[text]` as a reference when the label is actually defined in the
file.

## absolute-path

The link starts with `/`. This is a warning, not an error, because it is
legitimate on a site served from `/`.

```
docs/a.md:8:1  absolute-path  warning  "/etc/passwd" starts with "/" and resolves from the filesystem root
```

See [Configuration](configuration.md#absolute-paths-are-a-warning-not-an-error)
for how to resolve it instead of warning, or to fail on it with `--strict`.

## Exit status

Only `error`-severity problems fail the run:

| Status | Meaning |
| --- | --- |
| 0 | No errors. Warnings may still have been printed. |
| 1 | At least one error. |
| 2 | Usage error: an unknown flag, or a missing option value. |

A missing *input path* is a finding, not a usage error, so it exits 1.
