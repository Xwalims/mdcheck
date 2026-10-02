'use strict';

/**
 * Temp-directory helpers shared by the tests. Every fixture is a real
 * directory tree on disk, because mdcheck's whole job is reading files and
 * resolving targets against the filesystem -- mocking that would test nothing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** @type {string[]} directories to remove in cleanup() */
const created = [];

/**
 * Write a tree of files into a fresh temp directory.
 * @param {Record<string, string>} files relative path -> contents
 * @returns {string} the absolute path of the directory
 */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcheck-test-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  return dir;
}

/** Remove every fixture created so far. */
function cleanup() {
  while (created.length) {
    const dir = created.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir that cannot be removed must not fail the test run.
    }
  }
}

module.exports = { fixture, cleanup };
