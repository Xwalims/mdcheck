'use strict';

// Regression tests for the counts tally in src/report.js.
//
// The bug: `counts[code] = (counts[code] ?? 0) + 1`. The read walks the
// prototype chain, so for a code that names a member of Object.prototype it
// returns that member instead of undefined, `?? 0` never fires, and the
// addition runs on the wrong type. `__proto__` then lost the count outright
// (the string "[object Object]1" was assigned as the prototype), while
// `constructor`/`toString` stored the string "function Object() { [native
// code] }1" in a map documented as Record<string, number>.

const test = require('node:test');
const assert = require('node:assert');
const { emptyReport, addProblem, finalize, formatText, formatJson } = require('../src/report.js');

/** Every name that exists on Object.prototype, plus the accessor and a control. */
const PROTO_MEMBERS = [
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];

/** Build a report carrying one problem per given code, then finalize it. */
function tally(codes) {
  const report = emptyReport();
  for (const code of codes) {
    addProblem(report, { file: 'a.md', line: 1, column: 1, code, target: '', message: 'm' });
  }
  return finalize(report);
}

test('every Object.prototype member name counts as a number', () => {
  for (const code of PROTO_MEMBERS) {
    const report = tally([code]);
    assert.strictEqual(
      typeof report.counts[code],
      'number',
      `counts[${JSON.stringify(code)}] should be a number`
    );
    assert.strictEqual(
      report.counts[code],
      1,
      `counts[${JSON.stringify(code)}] should be 1`
    );
  }
});

test('a __proto__ code is an own key, not a prototype swap', () => {
  const report = tally(['__proto__']);
  assert.ok(Object.prototype.hasOwnProperty.call(report.counts, '__proto__'));
  assert.strictEqual(Object.getPrototypeOf(report.counts), Object.prototype);
  // The whole point: the tally must not have leaked onto a shared prototype.
  assert.strictEqual(({}).polluted, undefined);
});

test('prototype member names do not disturb the inherited members', () => {
  const report = tally(['constructor', 'toString']);
  assert.strictEqual(typeof report.counts, 'object');
  assert.strictEqual(typeof report.counts.hasOwnProperty, 'function');
  assert.strictEqual(typeof report.counts.toString, 'number');
  assert.strictEqual(typeof report.counts.constructor, 'number');
});

test('counts sum to the number of problems for hostile code names', () => {
  const codes = [...PROTO_MEMBERS, 'file-not-found', 'file-not-found', 'file-not-found', 'anchor-not-found'];
  const report = tally(codes);
  const sum = Object.values(report.counts).reduce((a, n) => a + n, 0);
  assert.strictEqual(sum, report.totals.problems, 'counts must account for every problem');
  assert.strictEqual(report.totals.problems, codes.length);
  assert.strictEqual(report.counts['file-not-found'], 3);
  assert.strictEqual(report.counts['anchor-not-found'], 1);
});

test('counts sum to the number of problems when finalize runs twice', () => {
  // finalize() rebuilds counts from scratch; the rebuild must agree with the
  // incremental tally that addProblem() already did.
  const report = tally(['__proto__', 'constructor', 'file-not-found', 'file-not-found']);
  const before = JSON.stringify(report.counts);
  const after = JSON.stringify(finalize(report).counts);
  assert.strictEqual(after, before);
});

test('incremental and rebuilt counts agree for every prototype member', () => {
  for (const code of PROTO_MEMBERS) {
    const report = emptyReport();
    for (let i = 0; i < 3; i += 1) {
      addProblem(report, { file: 'a.md', line: 1, column: 1, code, target: '', message: 'm' });
    }
    assert.strictEqual(report.counts[code], 3, `addProblem x3 for ${code}`);
    assert.strictEqual(finalize(report).counts[code], 3, `finalize for ${code}`);
  }
});

test('formatText prints a real count for a prototype member code', () => {
  const report = tally(['__proto__', 'file-not-found', 'file-not-found']);
  const text = formatText(report, { color: false });
  assert.match(text, /1 __proto__/);
  assert.match(text, /2 file-not-found/);
  // The old output leaked the function source into the summary line.
  assert.doesNotMatch(text, /\[native code\]/);
});

test('formatText sorts the summary numerically, not lexicographically', () => {
  // "constructor" used to sort as a string, so a bigger count could be listed
  // after a smaller one. Counts are numbers now, so b[1] - a[1] orders them.
  const codes = ['constructor', 'file-not-found', 'file-not-found', 'file-not-found'];
  const text = formatText(tally(codes), { color: false });
  const line = text.split('\n').find((l) => l.includes('file-not-found'));
  assert.ok(
    line.indexOf('3 file-not-found') < line.indexOf('1 constructor'),
    `expected 3 file-not-found before 1 constructor in: ${line}`
  );
});

test('formatJson emits numeric counts for prototype member codes', () => {
  const report = tally(['__proto__', 'constructor', 'toString', 'file-not-found']);
  const parsed = JSON.parse(formatJson(report));
  assert.strictEqual(parsed.counts.__proto__, 1);
  assert.strictEqual(parsed.counts.constructor, 1);
  assert.strictEqual(parsed.counts.toString, 1);
  assert.strictEqual(parsed.counts['file-not-found'], 1);
  for (const [code, n] of Object.entries(parsed.counts)) {
    assert.strictEqual(typeof n, 'number', `counts[${code}] should serialise as a number`);
  }
});

test('a normal report is unchanged by the fix', () => {
  const report = tally(['file-not-found', 'file-not-found', 'anchor-not-found']);
  assert.deepStrictEqual({ ...report.counts }, {
    'file-not-found': 2,
    'anchor-not-found': 1,
  });
  assert.deepStrictEqual(Object.keys(report.counts).sort(), ['anchor-not-found', 'file-not-found']);
});
