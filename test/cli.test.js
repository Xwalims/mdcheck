'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { main, parseArgs, FLAGS, VALUED } = require('../src/cli.js');
const { checkFile, checkPaths, CODES, EXIT, normalizeExtensions, collectFiles } = require('../src/index.js');
const { fixture, cleanup } = require('./helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'mdcheck.js');

/** Run the real binary as a child process and return its result. */
function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, NO_COLOR: '1', ...(opts.env ?? {}) },
  });
}

/** Capture stdout/stderr from calling main() in-process. */
function call(args, opts = {}) {
  const out = [];
  const err = [];
  const code = main(args, {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: opts.env ?? { NO_COLOR: '1' },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

test.after(cleanup);

// --- argument parsing -----------------------------------------------------

test('parseArgs defaults to the current directory', () => {
  const parsed = parseArgs([]);
  assert.deepStrictEqual(parsed.paths, ['.']);
  assert.strictEqual(parsed.options.json, false);
  assert.strictEqual(parsed.options.checkExternal, false);
});

test('parseArgs accepts paths and flags', () => {
  const parsed = parseArgs(['a.md', 'docs', '--json', '--no-color', '--quiet']);
  assert.deepStrictEqual(parsed.paths, ['a.md', 'docs']);
  assert.strictEqual(parsed.options.json, true);
  assert.strictEqual(parsed.options.noColor, true);
  assert.strictEqual(parsed.options.quiet, true);
});

test('parseArgs accepts --opt=value and --opt value', () => {
  assert.deepStrictEqual(parseArgs(['--ext=.md,.markdown']).options.extensions, ['.md', '.markdown']);
  assert.deepStrictEqual(parseArgs(['--ext', 'md']).options.extensions, ['.md']);
  // Index files are whole names, so no dot is added to them.
  assert.deepStrictEqual(parseArgs(['--index-file', 'HOME.md,docs.md']).options.indexFiles, [
    'HOME.md',
    'docs.md',
  ]);
});

test('parseArgs reports an unknown option', () => {
  const parsed = parseArgs(['--nope']);
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.error, /unknown option: --nope/);
});

test('parseArgs reports a missing value', () => {
  const parsed = parseArgs(['--ext']);
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.error, /--ext needs a value/);
});

test('parseArgs treats everything after -- as a path', () => {
  const parsed = parseArgs(['--', '--json', '-x.md']);
  assert.deepStrictEqual(parsed.paths, ['--json', '-x.md']);
});

test('parseArgs recognizes help and version', () => {
  assert.strictEqual(parseArgs(['--help']).action, 'help');
  assert.strictEqual(parseArgs(['-h']).action, 'help');
  assert.strictEqual(parseArgs(['--version']).action, 'version');
  assert.strictEqual(parseArgs(['-v']).action, 'version');
});

test('normalizeExtensions adds dots and lowercases', () => {
  assert.deepStrictEqual(normalizeExtensions('MD, .Markdown'), ['.md', '.markdown']);
  assert.deepStrictEqual(normalizeExtensions(['txt']), ['.txt']);
  // An empty list falls back to the defaults rather than checking nothing.
  assert.deepStrictEqual(normalizeExtensions(''), ['.md', '.markdown']);
});

// --- validation rules -----------------------------------------------------

test('a valid relative link produces no problems', () => {
  const dir = fixture({ 'a.md': '# A\n\n[ok](b.md)\n', 'b.md': '# B\n' });
  const report = checkFile(`${dir}/a.md`);
  assert.deepStrictEqual(report.problems, []);
  assert.strictEqual(report.ok, true);
});

test('a missing target file is file-not-found', () => {
  const dir = fixture({ 'a.md': '# A\n\n[bad](nope.md)\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.FILE_NOT_FOUND);
  assert.strictEqual(problem.target, 'nope.md');
  assert.strictEqual(problem.line, 3);
  assert.strictEqual(problem.column, 1);
});

test('a missing anchor is anchor-not-found', () => {
  const dir = fixture({
    'a.md': '# A\n\n[bad](b.md#nope)\n',
    'b.md': '# Real Heading\n\n## Usage\n',
  });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.ANCHOR_NOT_FOUND);
  assert.strictEqual(problem.target, '#nope');
});

test('an anchor matching a heading is valid', () => {
  const dir = fixture({
    'a.md': '# A\n\n[ok](b.md#usage)\n',
    'b.md': '# Real\n\n## Usage\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('anchors are matched after slugging the heading', () => {
  const dir = fixture({
    'a.md': '# A\n\n[ok](b.md#hello-world)\n[ok2](b.md#c--c)\n[ok3](b.md#café-naïve)\n',
    'b.md': '# Hello, World!\n\n# C++ & C#\n\n# café naïve\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('anchors are compared case-insensitively', () => {
  const dir = fixture({
    'a.md': '# A\n\n[ok](b.md#USAGE)\n[ok2](b.md#Usage)\n',
    'b.md': '# Usage\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('anchors resolve against duplicate headings by their suffix', () => {
  const dir = fixture({
    'a.md': '# A\n\n[ok](b.md#usage)\n[ok1](b.md#usage-1)\n[ok2](b.md#usage-2)\n',
    'b.md': '# Usage\n\n# Usage\n\n# Usage\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('an anchor percent-encoded in the link is decoded before matching', () => {
  const dir = fixture({
    'a.md': '# A\n\n[ok](b.md#caf%C3%A9)\n',
    'b.md': '# café\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('a bare hash means the top of the current document and is valid', () => {
  const dir = fixture({ 'a.md': '# A\n\n[top](#)\n' });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('a self anchor is checked against the current document', () => {
  const dir = fixture({ 'a.md': '# A\n\n## Section\n\n[ok](#section)\n\n[bad](#nope)\n' });
  const report = checkFile(`${dir}/a.md`);
  assert.strictEqual(report.problems.length, 1);
  assert.strictEqual(report.problems[0].code, CODES.ANCHOR_NOT_FOUND);
  assert.strictEqual(report.problems[0].line, 7);
});

test('an empty destination is empty-target', () => {
  const dir = fixture({ 'a.md': '# A\n\n[bad]()\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.EMPTY_TARGET);
});

test('a link with an unclosed paren is malformed-link', () => {
  const dir = fixture({ 'a.md': '# A\n\n[bad](b.md and text\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.MALFORMED_LINK);
});

test('an unclosed code fence is reported', () => {
  const dir = fixture({ 'a.md': '# A\n\n```js\nsome code\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.UNCLOSED_CODE_FENCE);
  assert.strictEqual(problem.line, 3);
});

test('a leading slash is absolute-path and only a warning', () => {
  const dir = fixture({ 'a.md': '# A\n\n[abs](/docs/b.md)\n', 'docs/b.md': '# B\n' });
  const report = checkFile(`${dir}/a.md`);
  assert.strictEqual(report.problems.length, 1);
  assert.strictEqual(report.problems[0].code, CODES.ABSOLUTE_PATH);
  assert.strictEqual(report.problems[0].severity, 'warning');
  // A warning alone keeps the report ok.
  assert.strictEqual(report.ok, true);
});

test('absolute-path is resolved instead of warned when opted in', () => {
  const cwd = process.cwd();
  process.chdir('/');
  try {
    const dir = fixture({ 'docs/b.md': '# B\n' });
    fs.writeFileSync(`${dir}/a.md`, '# A\n\n[abs](/tmp/nope/x.md)\n', 'utf8');
    const report = checkFile(`${dir}/a.md`, { followRootAbsolute: true });
    assert.strictEqual(report.counts[CODES.ABSOLUTE_PATH], undefined);
    assert.strictEqual(report.counts[CODES.FILE_NOT_FOUND], 1);
  } finally {
    process.chdir(cwd);
  }
});

test('a directory link is valid when it contains a configured index file', () => {
  const dir = fixture({
    'a.md': '# A\n\n[docs](docs)\n',
    'docs/README.md': '# Docs\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('a directory link with no index file is file-not-found', () => {
  const dir = fixture({ 'a.md': '# A\n\n[docs](docs)\n', 'docs/other.md': '# Other\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.FILE_NOT_FOUND);
  assert.match(problem.message, /README\.md, index\.md/);
});

test('the index-file list is configurable', () => {
  const dir = fixture({
    'a.md': '# A\n\n[docs](docs)\n',
    'docs/HOME.md': '# Docs\n',
  });
  assert.strictEqual(checkFile(`${dir}/a.md`).problems.length, 1);
  assert.deepStrictEqual(checkFile(`${dir}/a.md`, { indexFiles: ['HOME.md'] }).problems, []);
});

test('external links are skipped and counted by default', () => {
  const dir = fixture({
    'a.md': '# A\n\n[web](https://example.com) <https://example.org> <a@b.com>\n',
  });
  const report = checkFile(`${dir}/a.md`);
  assert.deepStrictEqual(report.problems, []);
  assert.strictEqual(report.totals.skippedExternal, 3);
});

test('--check-external checks external links without a network call', () => {
  const dir = fixture({
    'a.md': '# A\n\n<https://example.com>\n\n<https://>\n\n<mailto:>\n',
  });
  const report = checkFile(`${dir}/a.md`, { checkExternal: true });
  assert.strictEqual(report.totals.skippedExternal, 0);
  // The two hostless URLs are typos; the real one is left alone.
  assert.strictEqual(report.problems.length, 2);
  assert.ok(report.problems.every((p) => p.code === CODES.EMPTY_TARGET));
});

test('--check-external flags trailing whitespace in an external URL', () => {
  // An autolink cannot contain a space, so a trailing-space URL is only
  // reachable through a link destination.
  const dir = fixture({ 'a.md': '# A\n\n[bad](https://example.com )\n' });
  const report = checkFile(`${dir}/a.md`, { checkExternal: true });
  assert.strictEqual(report.problems[0].code, CODES.TRAILING_WHITESPACE_IN_URL);
});

test('a URL with a trailing space is trailing-whitespace-in-url', () => {
  const dir = fixture({ 'a.md': '# A\n\n[bad](<b.md >)\n', 'b.md': '# B\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.TRAILING_WHITESPACE_IN_URL);
});

test('reference definitions and usages resolve together', () => {
  const dir = fixture({
    'a.md': '# A\n\nSee [the docs][ref].\n\n[ref]: b.md "Title"\n',
    'b.md': '# B\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('a broken reference definition target is reported', () => {
  const dir = fixture({ 'a.md': '# A\n\nSee [the docs][ref].\n\n[ref]: nope.md\n' });
  const codes = checkFile(`${dir}/a.md`).problems.map((p) => p.code);
  // Reported at both the definition and the usage.
  assert.deepStrictEqual(codes, [CODES.FILE_NOT_FOUND, CODES.FILE_NOT_FOUND]);
});

test('a reference usage with no definition is unresolved-reference', () => {
  const dir = fixture({ 'a.md': '# A\n\nSee [text][missing].\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.code, CODES.UNRESOLVED_REFERENCE);
});

test('a shortcut reference that is not defined is not a link at all', () => {
  const dir = fixture({ 'a.md': '# A\n\nSee [not a link] here.\n' });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('links inside fenced code and inline code are never checked', () => {
  const dir = fixture({
    'a.md': [
      '# A', // 1
      '', // 2
      '```', // 3   <- a 3-backtick fence opens
      '[fenced](nope.md)', // 4
      '[still fenced](nope.md)', // 5
      '```', // 6   <- closes it (same char, length >= 3)
      '', // 7
      '````md', // 8   <- a 4-backtick fence opens with an info string
      '[nested](nope.md)', // 9
      '```', // 10  <- only 3 backticks: does NOT close the 4-backtick fence
      '[still fenced](nope.md)', // 11
      '````', // 12  <- closes it
      '', // 13
      '`[inline](nope.md)`', // 14
      '', // 15
      '[real](b.md)', // 16
      '', // 17
    ].join('\n'),
    'b.md': '# B\n',
  });
  const report = checkFile(`${dir}/a.md`);
  assert.deepStrictEqual(report.problems, []);
});

test('a tilde fence also hides links', () => {
  const dir = fixture({
    'a.md': '# A\n\n~~~\n[hidden](nope.md)\n~~~\n\n[real](b.md)\n',
    'b.md': '# B\n',
  });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('a directory is walked recursively for markdown files', () => {
  const dir = fixture({
    'a.md': '# A\n',
    'docs/b.md': '# B\n\n[bad](c.md)\n',
    'docs/deep/c.md': '# C\n',
    'docs/notes.txt': 'ignored [nope](x.md)\n',
  });
  const report = checkPaths([dir]);
  assert.strictEqual(report.totals.files, 3);
  assert.strictEqual(report.problems.length, 1);
  assert.match(report.problems[0].file, /docs\/b\.md$/);
});

test('the extension list is configurable when walking a directory', () => {
  const dir = fixture({ 'a.md': '# A\n', 'b.markdown': '# B\n', 'c.mdown': '# C\n' });
  assert.strictEqual(checkPaths([dir]).totals.files, 2);
  assert.strictEqual(checkPaths([dir], { extensions: ['.mdown'] }).totals.files, 1);
});

test('collectFiles skips dot directories and node_modules', () => {
  const dir = fixture({
    'a.md': '# A\n',
    '.hidden/b.md': '# B\n',
    'node_modules/c.md': '# C\n',
  });
  const files = collectFiles(dir, ['.md']).map((f) => path.basename(f));
  assert.deepStrictEqual(files, ['a.md']);
});

test('the same file named twice is checked once', () => {
  const dir = fixture({ 'a.md': '# A\n\n[bad](nope.md)\n' });
  const report = checkPaths([`${dir}/a.md`, `${dir}/a.md`]);
  assert.strictEqual(report.totals.files, 1);
  assert.strictEqual(report.problems.length, 1);
});

test('a file is reported at most once even when linked from many places', () => {
  const dir = fixture({
    'a.md': '# A\n\n[1](b.md#nope)\n[2](b.md#nope)\n',
    'b.md': '# B\n',
  });
  const report = checkFile(`${dir}/a.md`);
  // Both occurrences are reported, but they name one file.
  assert.strictEqual(report.problems.length, 2);
  assert.strictEqual(report.files.length, 1);
  const file = report.files[0].file;
  assert.ok(
    file.endsWith('a.md') && !file.includes('..'),
    `expected a clean path for the file, got ${JSON.stringify(file)}`
  );
  for (const problem of report.problems) assert.strictEqual(problem.file, file);
});

test('a hidden directory is not walked but is still resolvable as a target', () => {
  const dir = fixture({
    'a.md': '[hidden](.hidden/h.md)\n',
    '.hidden/h.md': '# Hidden\n',
  });
  // The link resolves...
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
  // ...but the file inside the dot directory is not checked on its own.
  const report = checkPaths([dir]);
  assert.strictEqual(report.totals.files, 1);
  assert.strictEqual(report.files[0].file.endsWith('a.md'), true);
});

test('several spellings of one file all resolve', () => {
  const dir = fixture({
    'a.md': '[1](b.md)\n[2](./b.md)\n[3](b.md#head)\n[4](../b.md)\n',
    'b.md': '# Head\n',
  });
  const report = checkFile(`${dir}/a.md`);
  // The fourth escapes the fixture directory and genuinely does not exist.
  assert.strictEqual(report.problems.length, 1);
  assert.strictEqual(report.problems[0].code, CODES.FILE_NOT_FOUND);
  assert.strictEqual(report.problems[0].line, 4);
});

test('a file listed as both a directory member and an explicit path is checked once', () => {
  const dir = fixture({ 'a.md': '# A\n', 'docs/b.md': '# B\n\n[x](c.md)\n' });
  const report = checkPaths([dir, `${dir}/a.md`, `${dir}/a.md`]);
  assert.strictEqual(report.totals.files, 2);
  assert.strictEqual(report.problems.length, 1);
});

test('an empty directory is a clean run', () => {
  const dir = fixture({});
  const report = checkPaths([dir]);
  assert.strictEqual(report.ok, true);
  assert.deepStrictEqual(report.problems, []);
  assert.strictEqual(report.totals.files, 0);
});

test('CRLF line endings do not shift reported positions', () => {
  const dir = fixture({ 'a.md': '# A\r\n\r\n[bad](nope.md)\r\n' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.line, 3);
  assert.strictEqual(problem.column, 1);
  assert.strictEqual(problem.code, CODES.FILE_NOT_FOUND);
});

test('an empty file is clean', () => {
  const dir = fixture({ 'a.md': '' });
  assert.deepStrictEqual(checkFile(`${dir}/a.md`).problems, []);
});

test('a file with no trailing newline still reports correctly', () => {
  const dir = fixture({ 'a.md': '# A\n\n[bad](nope.md)' });
  const [problem] = checkFile(`${dir}/a.md`).problems;
  assert.strictEqual(problem.line, 3);
});

test('setext headings are not collected for anchors (documented limitation)', () => {
  // mdcheck recognizes ATX headings only. A link to a setext heading's anchor
  // is therefore reported as anchor-not-found. This is a known limit, stated
  // in the README, and pinned here so it cannot change unnoticed.
  const dir = fixture({ 'a.md': 'Title\n=====\n\n[x](b.md#title)\n', 'b.md': 'Title\n=====\n' });
  assert.strictEqual(checkFile(`${dir}/a.md`).problems[0].code, CODES.ANCHOR_NOT_FOUND);
});

test('a heading with no links is still counted as a checked file', () => {
  const dir = fixture({ 'a.md': '# A\n\n## B\n\n### C\n' });
  const report = checkFile(`${dir}/a.md`);
  assert.strictEqual(report.totals.files, 1);
  assert.strictEqual(report.totals.links, 0);
  assert.strictEqual(report.ok, true);
});

// --- exit codes -----------------------------------------------------------

test('a clean run exits 0', () => {
  const dir = fixture({ 'a.md': '# A\n\n[ok](b.md)\n', 'b.md': '# B\n' });
  assert.strictEqual(call([`${dir}/a.md`]).code, EXIT.CLEAN);
  assert.strictEqual(run([`${dir}/a.md`]).status, 0);
});

test('a run with problems exits 1', () => {
  const dir = fixture({ 'a.md': '# A\n\n[bad](nope.md)\n' });
  assert.strictEqual(call([`${dir}/a.md`]).code, EXIT.PROBLEMS);
  assert.strictEqual(run([`${dir}/a.md`]).status, 1);
});

test('a usage error exits 2', () => {
  assert.strictEqual(call(['--nope']).code, EXIT.USAGE);
  assert.strictEqual(run(['--nope']).status, 2);
  assert.strictEqual(run(['--ext']).status, 2);
});

test('a nonexistent input path exits 1, not 2', () => {
  // A missing file is a finding about the document set, not a usage error.
  const result = run(['/definitely/not/here.md']);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /file-not-found/);
});

test('a warning alone exits 0', () => {
  const dir = fixture({ 'a.md': '# A\n\n[abs](/x/y.md)\n' });
  assert.strictEqual(run([`${dir}/a.md`]).status, 0);
});

test('--strict makes a warning fail', () => {
  const dir = fixture({ 'a.md': '# A\n\n[abs](/x/y.md)\n' });
  assert.strictEqual(run([`${dir}/a.md`, '--strict']).status, 1);
});

test('--help and --version exit 0 and print something', () => {
  const help = run(['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /Usage/);
  const version = run(['--version']);
  assert.strictEqual(version.status, 0);
  assert.strictEqual(version.stdout.trim(), require('../package.json').version);
});

test('every flag the parser accepts is documented in --help', () => {
  // mdcheck's own error message tells users to "add --follow-root-absolute".
  // A flag that exists but is missing from --help is a flag nobody can discover,
  // and the regression is invisible until a user greps the source for it.
  // Hence this contract test: FLAGS/VALUED are the single source of truth for
  // what the CLI accepts, and --help must mention every one of them.
  const help = run(['--help']).stdout;
  for (const flag of [...FLAGS.keys(), ...VALUED.keys()]) {
    assert.ok(help.includes(flag), `--help does not document ${flag}`);
  }
});

test('every flag --help documents is actually accepted', () => {
  // The other direction: help text that lists a flag the parser rejects is an
  // instruction that fails with "unknown option". Scan the usage block for
  // long flags and require each one to parse. Valued flags get a value, since
  // "--ext" with nothing after it is correctly a usage error, not acceptance.
  const usage = run(['--help']).stdout;
  const documented = new Set(usage.match(/--[a-z][a-z0-9-]*/g) || []);
  for (const flag of documented) {
    const argv = VALUED.has(flag) ? [flag, '.md'] : [flag];
    const parsed = parseArgs(argv);
    assert.ok(parsed.ok, `--help documents ${flag} but parseArgs rejects it`);
  }
});

test('a flag the tool recommends in an error message must exist and be in --help', () => {
  // src/report.js tells the user to add --follow-root-absolute. Keep the message,
  // the flag and the help text in lockstep: the suggestion has to be usable.
  const dir = fixture({ 'a.md': '# A\n\n[missing](does-not-exist.md)\n' });
  const result = run([`${dir}/a.md`, '--no-color']);
  const suggested = result.stdout.match(/add --[a-z][a-z0-9-]+/);
  assert.ok(suggested, 'expected the file-not-found message to suggest a flag');
  const flag = suggested[0].replace('add ', '');
  assert.ok(FLAGS.has(flag), `${flag} is suggested to users but is not a real flag`);
  assert.ok(run(['--help']).stdout.includes(flag), `${flag} is suggested but not in --help`);
});

// --- CLI output -----------------------------------------------------------

test('the CLI reports a real broken link with its line and column', () => {
  const dir = fixture({
    'broken.md': '# Broken\n\n## Links\n\n[missing file](does-not-exist.md)\n',
  });
  const result = run([`${dir}/broken.md`, '--no-color']);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /broken\.md/);
  assert.match(result.stdout, /:5:1/);
  assert.match(result.stdout, /file-not-found/);
  assert.match(result.stdout, /does-not-exist\.md/);
});

test('--json emits a machine-readable report', () => {
  const dir = fixture({ 'broken.md': '# Broken\n\n[missing](nope.md)\n' });
  const result = run([`${dir}/broken.md`, '--json']);
  assert.strictEqual(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.problems.length, 1);
  assert.strictEqual(report.problems[0].code, 'file-not-found');
  assert.ok(Array.isArray(report.files));
  assert.ok(report.totals);
});

test('--json on a clean run is valid JSON with no problems', () => {
  const dir = fixture({ 'a.md': '# A\n' });
  const result = run([`${dir}/a.md`, '--json']);
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(JSON.parse(result.stdout).problems, []);
});

test('--quiet prints problems but no summary', () => {
  const dir = fixture({ 'broken.md': '# Broken\n\n[missing](nope.md)\n' });
  const result = run([`${dir}/broken.md`, '--no-color', '--quiet']);
  assert.match(result.stdout, /file-not-found/);
  assert.doesNotMatch(result.stdout, /problems in/);
});

test('the CLI writes nothing but the summary on a clean run', () => {
  const dir = fixture({ 'a.md': '# A\n' });
  const result = run([`${dir}/a.md`, '--no-color']);
  assert.match(result.stdout, /no problems in 1 file/);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\[/.test(result.stdout), 'expected no ANSI escapes');
});

test('the CLI emits ANSI color when FORCE_COLOR is set', () => {
  const dir = fixture({ 'broken.md': '# B\n\n[missing](nope.md)\n' });
  const result = run([`${dir}/broken.md`], { env: { NO_COLOR: '', FORCE_COLOR: '1' } });
  // eslint-disable-next-line no-control-regex
  assert.ok(/\[/.test(result.stdout), 'expected ANSI escapes');
});

test('the CLI accepts a directory and checks every markdown file in it', () => {
  const dir = fixture({
    'a.md': '# A\n',
    'docs/b.md': '# B\n\n[missing](c.md)\n',
  });
  const result = run([dir, '--no-color']);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /docs\/b\.md/);
  assert.match(result.stdout, /1 problem in 2 files/);
});
