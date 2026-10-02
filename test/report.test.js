'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  CODES,
  SEVERITY,
  emptyReport,
  addProblem,
  finalize,
  formatText,
  formatJson,
  shouldUseColor,
} = require('../src/report.js');
const { checkFile, checkPaths, DEFAULT_OPTIONS } = require('../src/index.js');
const { fixture, cleanup } = require('./helpers.js');

test.after(cleanup);

/** Build a report from a list of partial problems. */
function build(entries) {
  const report = emptyReport();
  for (const entry of entries) {
    report.files.push({ file: entry.file, problems: 0 });
    addProblem(report, {
      line: 1,
      column: 1,
      target: '',
      message: 'message',
      severity: SEVERITY.error,
      ...entry,
    });
  }
  return finalize(report);
}

test('an empty report is ok and has zero totals', () => {
  const report = finalize(emptyReport());
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.problems.length, 0);
  assert.deepStrictEqual(report.totals, { files: 0, problems: 0, links: 0, skippedExternal: 0 });
});

test('a report with no error-severity problems is ok', () => {
  const report = build([{ file: 'a.md', severity: SEVERITY.warning }]);
  assert.strictEqual(report.ok, true);
});

test('a report with an error-severity problem is not ok', () => {
  const report = build([{ file: 'a.md', code: CODES.FILE_NOT_FOUND }]);
  assert.strictEqual(report.ok, false);
});

test('problems are sorted by file, then line, then column', () => {
  const report = build([
    { file: 'b.md', line: 1, column: 1 },
    { file: 'a.md', line: 9, column: 1 },
    { file: 'a.md', line: 2, column: 5 },
    { file: 'a.md', line: 2, column: 1 },
  ]);
  assert.deepStrictEqual(
    report.problems.map((p) => `${p.file}:${p.line}:${p.column}`),
    ['a.md:2:1', 'a.md:2:5', 'a.md:9:1', 'b.md:1:1']
  );
});

test('counts tally by code', () => {
  const report = build([
    { file: 'a.md', code: CODES.FILE_NOT_FOUND },
    { file: 'a.md', code: CODES.FILE_NOT_FOUND },
    { file: 'a.md', code: CODES.ANCHOR_NOT_FOUND },
  ]);
  assert.deepStrictEqual(report.counts, {
    [CODES.FILE_NOT_FOUND]: 2,
    [CODES.ANCHOR_NOT_FOUND]: 1,
  });
});

test('per-file problem counts are filled in by finalize', () => {
  const report = build([
    { file: 'a.md', code: CODES.FILE_NOT_FOUND },
    { file: 'b.md', code: CODES.EMPTY_TARGET },
  ]);
  assert.deepStrictEqual(report.files, [
    { file: 'a.md', problems: 1 },
    { file: 'b.md', problems: 1 },
  ]);
});

test('formatJson round-trips the report', () => {
  const report = build([{ file: 'a.md', code: CODES.FILE_NOT_FOUND, message: 'boom' }]);
  const parsed = JSON.parse(formatJson(report));
  assert.strictEqual(parsed.problems[0].code, CODES.FILE_NOT_FOUND);
  assert.strictEqual(parsed.problems[0].message, 'boom');
  assert.strictEqual(parsed.ok, false);
});

test('formatText on a clean report says so', () => {
  const report = finalize(emptyReport());
  report.totals.files = 3;
  report.totals.links = 12;
  const text = formatText(report, { color: false });
  assert.match(text, /no problems in 3 files/);
  assert.match(text, /12 links checked/);
});

test('formatText on a clean report singularizes one file', () => {
  const report = finalize(emptyReport());
  report.totals.files = 1;
  report.totals.links = 1;
  const text = formatText(report, { color: false });
  assert.match(text, /no problems in 1 file \(1 link checked\)/);
});

test('formatText lists each problem with file, line, column and code', () => {
  const report = build([
    {
      file: 'docs/a.md',
      line: 12,
      column: 3,
      code: CODES.FILE_NOT_FOUND,
      target: 'missing.md',
      message: 'no file at "missing.md"',
    },
  ]);
  const text = formatText(report, { color: false });
  assert.match(text, /^docs\/a\.md$/m);
  assert.match(text, /docs\/a\.md:12:3 {2}file-not-found {2}error/);
  assert.match(text, /target: missing\.md/);
  assert.match(text, /1 problem in 1 file/);
});

test('formatText pluralizes the summary count', () => {
  const report = build([
    { file: 'a.md', code: CODES.FILE_NOT_FOUND },
    { file: 'a.md', code: CODES.ANCHOR_NOT_FOUND },
  ]);
  assert.match(formatText(report, { color: false }), /2 problems in 1 file/);
});

test('formatText --quiet omits the summary but keeps problems', () => {
  const report = build([{ file: 'a.md', code: CODES.FILE_NOT_FOUND }]);
  const text = formatText(report, { color: false, quiet: true });
  assert.match(text, /file-not-found/);
  assert.doesNotMatch(text, /problems in/);
});

test('formatText --quiet on a clean report prints nothing', () => {
  const report = finalize(emptyReport());
  report.totals.files = 2;
  assert.strictEqual(formatText(report, { color: false, quiet: true }), '');
});

test('formatText ends with a newline', () => {
  const report = build([{ file: 'a.md', code: CODES.FILE_NOT_FOUND }]);
  assert.ok(formatText(report, { color: false }).endsWith('\n'));
});

test('formatText mentions skipped external links', () => {
  const report = build([{ file: 'a.md', code: CODES.FILE_NOT_FOUND }]);
  report.totals.skippedExternal = 4;
  assert.match(formatText(report, { color: false }), /4 external links skipped/);
});

test('shouldUseColor respects noColor, NO_COLOR, FORCE_COLOR and TTY', () => {
  const tty = { isTTY: true };
  const plain = { isTTY: false };
  assert.strictEqual(shouldUseColor({ noColor: true, stream: tty, env: {} }), false);
  assert.strictEqual(shouldUseColor({ noColor: false, stream: tty, env: { NO_COLOR: '1' } }), false);
  assert.strictEqual(shouldUseColor({ noColor: false, stream: plain, env: { FORCE_COLOR: '1' } }), true);
  assert.strictEqual(shouldUseColor({ noColor: false, stream: plain, env: {} }), false);
  assert.strictEqual(shouldUseColor({ noColor: false, stream: tty, env: {} }), true);
});

test('formatText emits no ANSI escapes when color is off', () => {
  const report = build([{ file: 'a.md', code: CODES.FILE_NOT_FOUND }]);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\[/.test(formatText(report, { color: false })));
});

test('formatText emits ANSI escapes when color is on', () => {
  const report = build([{ file: 'a.md', code: CODES.FILE_NOT_FOUND }]);
  // eslint-disable-next-line no-control-regex
  assert.ok(/\[/.test(formatText(report, { color: true })));
});

test('every code has help text', () => {
  const { CODE_HELP } = require('../src/report.js');
  for (const code of Object.values(CODES)) {
    assert.strictEqual(typeof CODE_HELP[code], 'string', `missing help for ${code}`);
    assert.ok(CODE_HELP[code].length > 0);
  }
});

test('DEFAULT_OPTIONS is frozen and holds the documented defaults', () => {
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS));
  assert.deepStrictEqual([...DEFAULT_OPTIONS.extensions], ['.md', '.markdown']);
  assert.deepStrictEqual([...DEFAULT_OPTIONS.indexFiles], ['README.md', 'index.md']);
  assert.strictEqual(DEFAULT_OPTIONS.checkExternal, false);
});

test('report.problems entries have every required field', () => {
  const dir = fixture({
    'a.md': '# A\n\n[missing](nope.md)\n',
  });
  const report = checkFile(`${dir}/a.md`);
  assert.ok(report.problems.length >= 1);
  for (const problem of report.problems) {
    for (const key of ['file', 'line', 'column', 'code', 'target', 'message']) {
      assert.ok(key in problem, `missing ${key}`);
    }
    assert.strictEqual(typeof problem.line, 'number');
    assert.strictEqual(typeof problem.column, 'number');
    assert.ok(Object.values(CODES).includes(problem.code));
  }
});

test('checkPaths reports a path that does not exist', () => {
  const report = checkPaths(['/definitely/not/here.md']);
  assert.strictEqual(report.problems.length, 1);
  assert.strictEqual(report.problems[0].code, CODES.FILE_NOT_FOUND);
});

test('checkPaths is stable for the same input', () => {
  const dir = fixture({ 'a.md': '# A\n\n[x](nope.md)\n[y](nope2.md)\n' });
  const first = checkPaths([`${dir}/a.md`]);
  const second = checkPaths([`${dir}/a.md`]);
  assert.deepStrictEqual(first, second);
});
