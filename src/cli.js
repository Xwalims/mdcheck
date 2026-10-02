'use strict';

/**
 * mdcheck / cli.js
 *
 * Argument parsing and the top-level run function. Kept free of process.exit
 * so it can be required and tested directly: main() returns the exit code and
 * bin/mdcheck.js assigns it.
 */

const { EXIT, DEFAULT_OPTIONS, checkPaths, normalizeExtensions } = require('./index.js');
const { formatText, formatJson, shouldUseColor } = require('./report.js');

const USAGE = `mdcheck - zero-dependency markdown link and anchor checker

Usage
  mdcheck [paths...] [options]

Paths may be files or directories. Directories are walked recursively for
markdown files. With no paths, the current directory is checked.

Options
  --json                     print a machine-readable JSON report
  --no-color                 never emit ANSI color (also honours NO_COLOR)
  --ext <list>               file extensions to treat as markdown
                             (default: ${DEFAULT_OPTIONS.extensions.join(',')})
  --check-external           also check external http/https/mailto links
                             (shape only; mdcheck never opens a socket)
  --index-file <list>        filenames that make a directory link valid
                             (default: ${DEFAULT_OPTIONS.indexFiles.join(',')})
  --quiet                    only print problems, no summary
  --strict                   treat warnings (e.g. absolute-path) as failures
  -h, --help                 show this help
  -v, --version              print the version

Exit codes
  0  no problems
  1  problems found
  2  usage error or unreadable path
`;

const FLAGS = new Map([
  ['--json', 'json'],
  ['--no-color', 'noColor'],
  ['--check-external', 'checkExternal'],
  ['--quiet', 'quiet'],
  ['--follow-root-absolute', 'followRootAbsolute'],
  ['--strict', 'strict'],
]);

const VALUED = new Map([
  ['--ext', 'extensions'],
  ['--index-file', 'indexFiles'],
]);

/**
 * Parse argv into options and paths.
 * @param {string[]} argv arguments after the node binary and script
 * @returns {{ok: true, paths: string[], options: object, action: string|null}
 *          |{ok: false, error: string}}
 */
function parseArgs(argv) {
  const options = {
    json: false,
    noColor: false,
    checkExternal: false,
    quiet: false,
    strict: false,
    followRootAbsolute: false,
    extensions: null,
    indexFiles: null,
  };
  const paths = [];
  let action = null;
  let onlyPaths = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (onlyPaths) {
      paths.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPaths = true;
      continue;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      paths.push(arg);
      continue;
    }

    // --opt=value
    let name = arg;
    let inlineValue = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    if (name === '-h' || name === '--help') {
      action = 'help';
      continue;
    }
    if (name === '-v' || name === '--version') {
      action = 'version';
      continue;
    }
    if (FLAGS.has(name)) {
      options[FLAGS.get(name)] = true;
      continue;
    }
    if (VALUED.has(name)) {
      const value = inlineValue !== null ? inlineValue : argv[++i];
      if (value === undefined || value === '') {
        return { ok: false, error: `${name} needs a value` };
      }
      options[VALUED.get(name)] = normalizeExtensions(value);
      continue;
    }
    return { ok: false, error: `unknown option: ${name}` };
  }

  if (paths.length === 0) paths.push('.');
  return { ok: true, paths, options, action };
}

/**
 * Run mdcheck.
 * @param {string[]} argv arguments after the node binary and script
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}, env?: object, cwd?: string}} [io]
 * @returns {number} the exit code
 */
function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    stderr.write(`mdcheck: ${parsed.error}\n\n${USAGE}`);
    return EXIT.USAGE;
  }

  if (parsed.action === 'help') {
    stdout.write(USAGE);
    return EXIT.CLEAN;
  }
  if (parsed.action === 'version') {
    // eslint-disable-next-line global-require
    const { version } = require('../package.json');
    stdout.write(`${version}\n`);
    return EXIT.CLEAN;
  }

  let report;
  try {
    report = checkPaths(parsed.paths, {
      extensions: parsed.options.extensions,
      indexFiles: parsed.options.indexFiles,
      checkExternal: parsed.options.checkExternal,
      followRootAbsolute: parsed.options.followRootAbsolute,
    });
  } catch (err) {
    stderr.write(`mdcheck: ${err.message}\n`);
    return EXIT.USAGE;
  }

  const color = shouldUseColor({ noColor: parsed.options.noColor, stream: stdout, env });

  if (parsed.options.json) {
    stdout.write(formatJson(report) + '\n');
  } else {
    const text = formatText(report, { color, quiet: parsed.options.quiet });
    if (text) stdout.write(text);
  }

  // Warnings (absolute-path) do not fail the run unless --strict is passed.
  const failed = parsed.options.strict
    ? report.problems.length > 0
    : report.problems.some((p) => p.severity !== 'warning');
  return failed ? EXIT.PROBLEMS : EXIT.CLEAN;
}

module.exports = { main, parseArgs, USAGE };
