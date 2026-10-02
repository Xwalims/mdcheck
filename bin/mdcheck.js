#!/usr/bin/env node
'use strict';

// bin/mdcheck.js is intentionally tiny: it resolves the library and assigns
// the exit code the library returns, so every exit path (including thrown
// errors inside main) is still a real exit code and the whole program stays
// require()-able from tests.

const { main } = require('../src/cli.js');

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`mdcheck: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 2;
}
