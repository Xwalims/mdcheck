'use strict';

/**
 * mdcheck / index.js
 *
 * The library API. `checkFile(path, options)` checks one markdown file and
 * `checkPaths(paths, options)` checks a mix of files and directories and
 * returns a report object.
 *
 * All option defaults live in DEFAULT_OPTIONS below. Nothing else in the
 * project hard-codes a default.
 */

const fs = require('node:fs');
const path = require('node:path');
const { extract, parseTarget, KIND } = require('./links.js');
const { Slugger, normalizeLabel } = require('./slug.js');
const {
  CODES,
  SEVERITY,
  CODE_HELP,
  emptyReport,
  addProblem,
  finalize,
} = require('./report.js');

/** Exit codes. Also used by the CLI. */
const EXIT = Object.freeze({ CLEAN: 0, PROBLEMS: 1, USAGE: 2 });

/**
 * Every default in one place.
 *
 * - `extensions`   file extensions treated as markdown when walking a directory
 * - `indexFiles`   a link to a directory is valid only if one of these exists
 *                  inside it (GitHub resolves a directory link to its README)
 * - `checkExternal` when false, http/https/mailto links are counted as skipped
 * - `followRootAbsolute` when true, a leading "/" is resolved from the file's
 *                  own root instead of warned about (use for site sources)
 */
const DEFAULT_OPTIONS = Object.freeze({
  extensions: Object.freeze(['.md', '.markdown']),
  indexFiles: Object.freeze(['README.md', 'index.md']),
  checkExternal: false,
  followRootAbsolute: false,
  ignoreMissingTargets: false,
});

/**
 * Merge user options onto the defaults.
 * @param {object} [options]
 * @returns {typeof DEFAULT_OPTIONS}
 */
function resolveOptions(options = {}) {
  return {
    extensions: options.extensions
      ? normalizeExtensions(options.extensions)
      : DEFAULT_OPTIONS.extensions,
    indexFiles: options.indexFiles
      ? normalizeIndexFiles(options.indexFiles)
      : DEFAULT_OPTIONS.indexFiles,
    checkExternal: Boolean(options.checkExternal),
    followRootAbsolute: Boolean(options.followRootAbsolute),
    ignoreMissingTargets: Boolean(options.ignoreMissingTargets),
  };
}

/**
 * Accept "md,.markdown" or [".md"] and return [".md", ".markdown"]. Used for
 * file extensions, so a leading dot is added when missing.
 * @param {string|string[]} value
 * @returns {string[]}
 */
function normalizeExtensions(value) {
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = list
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith('.') ? item : `.${item}`));
  return out.length ? out : [...DEFAULT_OPTIONS.extensions];
}

/**
 * Accept "README.md,index.md" or ["README.md"] and return trimmed names.
 * Unlike extensions these are whole filenames, so no dot is added -- turning
 * "README.md" into ".README.md" would make the directory check never pass.
 * @param {string|string[]} value
 * @returns {string[]}
 */
function normalizeIndexFiles(value) {
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = list.map((item) => String(item).trim()).filter(Boolean);
  return out.length ? out : [...DEFAULT_OPTIONS.indexFiles];
}

/**
 * Anchor keys are compared case-insensitively, so index them lowercased.
 * @param {string} slug
 * @returns {string}
 */
function anchorKey(slug) {
  return String(slug).toLowerCase();
}

/**
 * Path to show in a diagnostic. Relative to the cwd when the file is inside
 * it, otherwise absolute -- a path like "../../../../tmp/x.md" is unreadable.
 * @param {string} absolute
 * @returns {string}
 */
function displayPathFor(absolute) {
  const relative = path.relative(process.cwd(), absolute);
  const inside =
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  return (inside ? relative || path.basename(absolute) : absolute).split(path.sep).join('/');
}

/**
 * Read a file's headings and anchors, cached so a document linked to 50 times
 * is only read once.
 * @param {string} absolutePath
 * @param {Map<string, {anchors: Set<string>, error: string|null}>} cache
 * @returns {{anchors: Set<string>, error: string|null}}
 */
function anchorIndexFor(absolutePath, cache) {
  const hit = cache.get(absolutePath);
  if (hit) return hit;
  const entry = { anchors: new Set(), error: null };
  cache.set(absolutePath, entry);
  let source;
  try {
    source = fs.readFileSync(absolutePath, 'utf8');
  } catch (err) {
    entry.error = err.code === 'ENOENT' ? 'ENOENT' : String(err.code || err.message);
    return entry;
  }
  const slugger = new Slugger();
  const doc = extract(source);
  for (const heading of doc.headings) entry.anchors.add(anchorKey(slugger.slug(heading.text)));
  return entry;
}

/**
 * Check whether a target directory is "resolvable", i.e. contains one of the
 * configured index files.
 * @param {string} dir
 * @param {string[]} indexFiles
 * @returns {boolean}
 */
function directoryHasIndex(dir, indexFiles) {
  try {
    const entries = fs.readdirSync(dir);
    const names = new Set(entries);
    return indexFiles.some((name) => names.has(name));
  } catch {
    return false;
  }
}

/**
 * Build a diagnostic message, appending the code's advice clause only when
 * `withHelp` is set. The per-code text is in CODE_HELP; it is advice, not a
 * restatement, so callers that already say it precisely opt out.
 * @param {string} code
 * @param {string} text
 * @param {boolean} [withHelp]
 * @returns {string}
 */
function message(code, text, withHelp = false) {
  return withHelp && CODE_HELP[code] ? `${text}; ${CODE_HELP[code]}` : text;
}

/**
 * Check the raw markdown of one file, appending diagnostics to `report`.
 * @param {string} absolutePath
 * @param {string} displayPath
 * @param {object} opts resolved options
 * @param {Map} anchorCache
 * @param {object} report
 */
function checkSource(absolutePath, displayPath, opts, anchorCache, report) {
  let source;
  try {
    source = fs.readFileSync(absolutePath, 'utf8');
  } catch (err) {
    addProblem(report, {
      file: displayPath,
      line: 1,
      column: 1,
      code: CODES.FILE_NOT_FOUND,
      target: displayPath,
      message: message(
        CODES.FILE_NOT_FOUND,
        `cannot read ${displayPath} (${err.code || err.message})`
      ),
    });
    return;
  }

  const doc = extract(source);
  report.files.push({ file: displayPath, problems: 0 });
  report.totals.files += 1;

  // Build this document's own anchor set for `#`-only links.
  const slugger = new Slugger();
  const selfAnchors = new Set();
  for (const heading of doc.headings) selfAnchors.add(anchorKey(slugger.slug(heading.text)));

  for (const fence of doc.unclosedFences) {
    addProblem(report, {
      file: displayPath,
      line: fence.line,
      column: fence.column,
      code: CODES.UNCLOSED_CODE_FENCE,
      target: '```',
      message: message(
        CODES.UNCLOSED_CODE_FENCE,
        `code fence opened here is never closed, so the rest of the file is skipped`,
        true
      ),
    });
  }

  for (const link of doc.links) {
    report.totals.links += 1;

    if (link.malformed) {
      addProblem(report, {
        file: displayPath,
        line: link.line,
        column: link.column,
        code: CODES.MALFORMED_LINK,
        target: link.label ?? '',
        message: message(CODES.MALFORMED_LINK, link.malformed),
      });
      continue;
    }

    // Resolve reference usages to their definition.
    let destination = link.destination;
    if (link.kind === KIND.REFERENCE_USAGE) {
      const definition = doc.definitions.get(link.referenceId);
      if (!definition) {
        // A [text] on its own is only a reference if the label is defined;
        // otherwise it is not a link at all and is left alone.
        if (link.shortcut) continue;
        addProblem(report, {
          file: displayPath,
          line: link.line,
          column: link.column,
          code: CODES.UNRESOLVED_REFERENCE,
          target: `[${link.label}]`,
          message: message(
            CODES.UNRESOLVED_REFERENCE,
            `no [${link.label}]: definition in this file`,
            true
          ),
        });
        continue;
      }
      // The usage inherits the definition's destination (and title).
      destination = definition.destination;
    }

    // Every link reaching this point has a real destination: reference usages were
    // resolved above, and definitions carry their own. The target is parsed
    // from the destination a renderer would use, while `rawSource` keeps the
    // untrimmed span -- a trailing space is only visible in the source.
    const rawSource = link.rawDestination ?? destination ?? '';
    const target = parseTarget(destination ?? '');

    if (target.external) {
      if (!opts.checkExternal) {
        report.totals.skippedExternal += 1;
        continue;
      }
      // --check-external does not fetch. It validates the shape of the URL and
      // flags whitespace and empty targets, which are the offline-detectable
      // failure modes. This keeps mdcheck network-free by design.
      checkExternalShape(report, displayPath, link, target, rawSource);
      continue;
    }

    if (target.empty) {
      addProblem(report, {
        file: displayPath,
        line: link.line,
        column: link.column,
        code: CODES.EMPTY_TARGET,
        target: target.raw,
        message: message(CODES.EMPTY_TARGET, 'link has no destination', true),
      });
      continue;
    }

    // "x.md " is broken but "x.md  \"Title\"" is fine. So: cut the span at any
    // title, unwrap angle brackets, and only then look at the tail -- the
    // space must survive to be detected. parseDestinationAndTitle already
    // trimmed `destination`, so this reads the untrimmed source span.
    const destSource = String(rawSource)
      .split(/[ \t]*["'(]/)[0]
      .replace(/^<(.*)>$/, '$1');
    if (/[ \t]$/.test(destSource) && target.file !== '') {
      addProblem(report, {
        file: displayPath,
        line: link.line,
        column: link.column,
        code: CODES.TRAILING_WHITESPACE_IN_URL,
        target: rawSource.trim(),
        message: message(
          CODES.TRAILING_WHITESPACE_IN_URL,
          `URL ends with whitespace: "${rawSource.trim()}"`
        ),
      });
      continue;
    }

    // An absolute path is reported as a warning only. It is still resolved and
    // validated, because on a site served from "/" the file may well exist --
    // but the finding is about portability, not about the file being broken.
    const warnAbsolute = target.absolute && !opts.followRootAbsolute;
    if (warnAbsolute) {
      addProblem(report, {
        file: displayPath,
        line: link.line,
        column: link.column,
        code: CODES.ABSOLUTE_PATH,
        target: target.raw,
        message: message(
          CODES.ABSOLUTE_PATH,
          `"${target.file}" starts with "/" and resolves from the filesystem root`
        ),
        severity: SEVERITY.warning,
      });
      continue;
    }

    // Resolve the file part.
    const baseDir = target.absolute && opts.followRootAbsolute ? process.cwd() : path.dirname(absolutePath);
    const resolved = target.absolute && opts.followRootAbsolute
      ? path.resolve('/', target.file)
      : path.resolve(baseDir, target.file);

    if (target.file === '') {
      // "#" or "#anchor": the current document.
      if (target.anchor !== '' && !selfAnchors.has(anchorKey(target.anchor))) {
        addProblem(report, {
          file: displayPath,
          line: link.line,
          column: link.column,
          code: CODES.ANCHOR_NOT_FOUND,
          target: `#${target.anchor}`,
          message: message(
            CODES.ANCHOR_NOT_FOUND,
            `no heading in this file produces #${target.anchor}`
          ),
        });
      }
      continue;
    }

    let stat = null;
    try {
      stat = fs.statSync(resolved);
    } catch {
      stat = null;
    }

    if (stat && stat.isDirectory()) {
      if (!directoryHasIndex(resolved, opts.indexFiles)) {
        addProblem(report, {
          file: displayPath,
          line: link.line,
          column: link.column,
          code: CODES.FILE_NOT_FOUND,
          target: target.raw,
          message: message(
            CODES.FILE_NOT_FOUND,
            `directory "${target.file}" contains none of ${opts.indexFiles.join(', ')}`
          ),
        });
      }
      continue;
    }

    if (!stat) {
      if (opts.ignoreMissingTargets) continue;
      addProblem(report, {
        file: displayPath,
        line: link.line,
        column: link.column,
        code: CODES.FILE_NOT_FOUND,
        target: target.raw,
        message: message(
          CODES.FILE_NOT_FOUND,
          `no file at "${target.file}" (relative to ${displayPath})`,
          true
        ),
      });
      continue;
    }

    // The file exists; now check the anchor, if any.
    if (target.anchor === '') continue;
    const index = anchorIndexFor(resolved, anchorCache);
    if (index.error) {
      addProblem(report, {
        file: displayPath,
        line: link.line,
        column: link.column,
        code: CODES.FILE_NOT_FOUND,
        target: target.raw,
        message: message(CODES.FILE_NOT_FOUND, `cannot read ${target.file} (${index.error})`),
      });
      continue;
    }
    if (!index.anchors.has(anchorKey(target.anchor))) {
      addProblem(report, {
        file: displayPath,
        line: link.line,
        column: link.column,
        code: CODES.ANCHOR_NOT_FOUND,
        target: `#${target.anchor}`,
        message: message(
          CODES.ANCHOR_NOT_FOUND,
          `no heading in ${target.file} produces #${target.anchor}`,
          true
        ),
      });
    }
  }
}

/**
 * Offline checks for external links: only the failure modes that are visible
 * without a network round trip. mdcheck never opens a socket, so
 * --check-external means "check the shape", not "fetch the URL".
 * @param {object} report
 * @param {string} displayPath
 * @param {object} link
 * @param {object} target
 */
function checkExternalShape(report, displayPath, link, target, rawSource) {
  const url = String(rawSource ?? target.raw);
  if (/[ \t]$/.test(url)) {
    addProblem(report, {
      file: displayPath,
      line: link.line,
      column: link.column,
      code: CODES.TRAILING_WHITESPACE_IN_URL,
      target: target.raw,
      message: message(
        CODES.TRAILING_WHITESPACE_IN_URL,
        `URL ends with whitespace: "${url.trim()}"`
      ),
    });
  }
  // A URL with a scheme but no host or path: "https:", "https://", "mailto:".
  // These are typos that would silently link nowhere. Anything with a
  // non-slash character after the scheme is treated as a real destination --
  // deciding whether a host resolves is a network question, and mdcheck does
  // not ask network questions.
  const afterScheme = target.raw.slice(target.raw.indexOf(':') + 1).trim();
  const hostless = afterScheme === '' || /^\/+$/.test(afterScheme) || afterScheme === '?';
  if (hostless) {
    addProblem(report, {
      file: displayPath,
      line: link.line,
      column: link.column,
      code: CODES.EMPTY_TARGET,
      target: target.raw,
      message: message(CODES.EMPTY_TARGET, `URL has no host or path: "${target.raw}"`, true),
    });
  }
}

/**
 * Check a single markdown file.
 * @param {string} filePath
 * @param {object} [options] see DEFAULT_OPTIONS
 * @returns {object} a report object
 */
function checkFile(filePath, options = {}) {
  return checkPaths([filePath], options);
}

/**
 * Recursively collect markdown files under a directory.
 * @param {string} dir
 * @param {string[]} extensions
 * @param {string[]} [skipDirs]
 * @returns {string[]} absolute paths, sorted
 */
function collectFiles(dir, extensions, skipDirs = []) {
  const skip = new Set(['node_modules', '.git', '.github', ...skipDirs]);
  const out = [];
  /** @param {string} current */
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (extensions.includes(path.extname(entry.name).toLowerCase())) out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Check a mix of files and directories.
 * @param {string[]} paths
 * @param {object} [options] see DEFAULT_OPTIONS
 * @returns {object} a report object
 */
function checkPaths(paths, options = {}) {
  const opts = resolveOptions(options);
  const report = emptyReport();
  const anchorCache = new Map();
  const inputs = Array.isArray(paths) ? paths : [paths];
  const seen = new Set();

  /** @param {string} absolute */
  const handle = (absolute) => {
    if (seen.has(absolute)) return;
    seen.add(absolute);
    checkSource(absolute, displayPathFor(absolute), opts, anchorCache, report);
  };

  for (const input of inputs) {
    const absolute = path.resolve(String(input));
    let stat = null;
    try {
      stat = fs.statSync(absolute);
    } catch {
      stat = null;
    }
    if (!stat) {
      addProblem(report, {
        file: String(input),
        line: 1,
        column: 1,
        code: CODES.FILE_NOT_FOUND,
        target: String(input),
        message: message(CODES.FILE_NOT_FOUND, `${input} does not exist`),
      });
      continue;
    }
    if (stat.isDirectory()) {
      for (const file of collectFiles(absolute, opts.extensions)) handle(file);
    } else {
      handle(absolute);
    }
  }

  if (report.files.length === 0 && inputs.length === 0) {
    report.totals.files = 0;
  }

  return finalize(report);
}

module.exports = {
  EXIT,
  DEFAULT_OPTIONS,
  CODES,
  SEVERITY,
  checkFile,
  checkPaths,
  resolveOptions,
  normalizeExtensions,
  normalizeIndexFiles,
  anchorKey,
  collectFiles,
};
