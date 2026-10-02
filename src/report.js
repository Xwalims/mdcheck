'use strict';

/**
 * mdcheck / report.js
 *
 * The diagnostic vocabulary and the two renderers (human text, JSON).
 *
 * A report is:
 *
 *   {
 *     files:  [{file, problems: number}],
 *     problems: [{file, line, column, code, target, message}],
 *     counts: {<code>: <number>, ...},
 *     totals: {files: number, problems: number, links: number, skippedExternal: number},
 *     ok: boolean
 *   }
 */

const CODES = Object.freeze({
  FILE_NOT_FOUND: 'file-not-found',
  ANCHOR_NOT_FOUND: 'anchor-not-found',
  EMPTY_TARGET: 'empty-target',
  MALFORMED_LINK: 'malformed-link',
  UNCLOSED_CODE_FENCE: 'unclosed-code-fence',
  ABSOLUTE_PATH: 'absolute-path',
  TRAILING_WHITESPACE_IN_URL: 'trailing-whitespace-in-url',
  UNRESOLVED_REFERENCE: 'unresolved-reference',
});

/** Codes that mean "a link is broken". Drives the exit status. */
const SEVERITY = Object.freeze({
  error: 'error',
  warning: 'warning',
});

/**
 * Advice appended to a diagnostic's message. Each is written so it adds
 * information the problem text does not already carry -- the caller composes
 * "what happened" from CODE_HELP's complement, never repeating it.
 */
const CODE_HELP = Object.freeze({
  [CODES.FILE_NOT_FOUND]:
    'use a relative path from the current file, or add --follow-root-absolute if this is a site',
  [CODES.ANCHOR_NOT_FOUND]:
    'anchors come from heading text: lowercase, punctuation dropped, spaces to hyphens',
  [CODES.EMPTY_TARGET]:
    'use the page URL for a self link, or "#" for the top of the current document',
  [CODES.MALFORMED_LINK]: 'check for an unclosed "(" or "]"',
  [CODES.UNCLOSED_CODE_FENCE]: 'close the fence with the same number of backticks or tildes',
  [CODES.ABSOLUTE_PATH]: 'a relative path works both on GitHub and on a local file server',
  [CODES.TRAILING_WHITESPACE_IN_URL]:
    'markdown keeps the space, so the URL no longer resolves; use <angle brackets> to work around it',
  [CODES.UNRESOLVED_REFERENCE]: 'reference definitions are file-scoped and are not shared between files',
});

/**
 * Build an empty report.
 * @returns {object}
 */
function emptyReport() {
  return {
    files: [],
    problems: [],
    counts: {},
    totals: { files: 0, problems: 0, links: 0, skippedExternal: 0 },
    ok: true,
  };
}

/**
 * Append a problem to a report, updating counts and totals.
 * @param {object} report
 * @param {{file: string, line: number, column: number, code: string, target: string, message: string, severity?: string}} problem
 * @returns {object} the same report, for chaining
 */
function addProblem(report, problem) {
  const entry = {
    file: problem.file,
    line: problem.line,
    column: problem.column,
    code: problem.code,
    target: problem.target,
    message: problem.message,
    severity: problem.severity ?? SEVERITY.error,
  };
  report.problems.push(entry);
  report.counts[entry.code] = (report.counts[entry.code] ?? 0) + 1;
  report.totals.problems += 1;
  report.ok = report.problems.every((p) => p.severity !== SEVERITY.error);
  return entry;
}

/**
 * Finalize counts/totals/ok and sort problems for stable output.
 * @param {object} report
 * @returns {object} a new, frozen report
 */
function finalize(report) {
  report.problems.sort((a, b) =>
    a.file === b.file ? a.line - b.line || a.column - b.column : a.file < b.file ? -1 : 1
  );
  report.files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const perFile = new Map();
  for (const problem of report.problems) {
    perFile.set(problem.file, (perFile.get(problem.file) ?? 0) + 1);
  }
  for (const file of report.files) {
    file.problems = perFile.get(file.file) ?? 0;
  }
  report.counts = {};
  for (const problem of report.problems) {
    report.counts[problem.code] = (report.counts[problem.code] ?? 0) + 1;
  }
  report.ok = report.problems.every((p) => p.severity !== SEVERITY.error);
  return report;
}

// --- terminal color -------------------------------------------------------

const ESC = '';
const ANSI = Object.freeze({
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
  green: `${ESC}[32m`,
});

/**
 * Wrap text in ANSI codes, or return it unchanged when color is off or the
 * stream is not a TTY.
 * @param {boolean} enabled
 * @param {string} code
 * @param {string} text
 * @returns {string}
 */
function paint(enabled, code, text) {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * Decide whether to emit ANSI color.
 * @param {{noColor: boolean, stream: {isTTY?: boolean}, env: object}} opts
 * @returns {boolean}
 */
function shouldUseColor(opts) {
  if (opts.noColor) return false;
  if (opts.env && opts.env.NO_COLOR !== undefined) return false;
  if (opts.env && opts.env.FORCE_COLOR !== undefined && opts.env.FORCE_COLOR !== '0') return true;
  return Boolean(opts.stream && opts.stream.isTTY);
}

/**
 * Render a report as human-readable text, one block per file.
 * @param {object} report
 * @param {{color?: boolean, quiet?: boolean}} [opts]
 * @returns {string} text ending in a newline (empty when there is nothing to say)
 */
function formatText(report, opts = {}) {
  const color = Boolean(opts.color);
  const quiet = Boolean(opts.quiet);
  const lines = [];

  for (const file of report.files) {
    const problems = report.problems.filter((p) => p.file === file.file);
    if (problems.length === 0) continue;
    lines.push(paint(color, ANSI.bold + ANSI.cyan, file.file));
    for (const problem of problems) {
      const location = paint(color, ANSI.dim, `${file.file}:${problem.line}:${problem.column}`);
      const severity =
        problem.severity === SEVERITY.warning
          ? paint(color, ANSI.yellow, 'warning')
          : paint(color, ANSI.red, 'error');
      lines.push(`  ${location}  ${paint(color, ANSI.dim, problem.code)}  ${severity}  ${problem.message}`);
      if (problem.target) {
        lines.push(paint(color, ANSI.dim, `      target: ${problem.target}`));
      }
    }
  }

  if (quiet) return lines.length ? lines.join('\n') + '\n' : '';

  if (report.problems.length === 0) {
    const n = report.totals.files;
    const label = n === 1 ? 'file' : 'files';
    const verb = report.totals.skippedExternal
      ? `, ${report.totals.skippedExternal} external link${report.totals.skippedExternal === 1 ? '' : 's'} skipped`
      : '';
    return (
      paint(color, ANSI.green, '✔') +
      ` no problems in ${n} ${label} (${report.totals.links} links checked${verb})\n`
    );
  }

  const n = report.problems.length;
  const summary = `${n} problem${n === 1 ? '' : 's'} in ${report.totals.files} file${report.totals.files === 1 ? '' : 's'}`;
  const parts = Object.entries(report.counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => `${count} ${code}`);
  lines.push('');
  lines.push(paint(color, ANSI.bold, summary));
  if (parts.length) lines.push(paint(color, ANSI.dim, parts.join(', ')));
  lines.push('');

  const skipped = report.totals.skippedExternal;
  if (skipped) {
    lines.push(
      paint(
        color,
        ANSI.dim,
        `${skipped} external link${skipped === 1 ? '' : 's'} skipped (pass --check-external to check them)`
      )
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a report as JSON.
 * @param {object} report
 * @returns {string}
 */
function formatJson(report) {
  return JSON.stringify(report, null, 2);
}

module.exports = {
  CODES,
  SEVERITY,
  CODE_HELP,
  ANSI,
  emptyReport,
  addProblem,
  finalize,
  paint,
  shouldUseColor,
  formatText,
  formatJson,
};
