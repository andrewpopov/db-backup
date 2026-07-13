#!/usr/bin/env node

const { runCli } = require('./index');

runCli(process.argv.slice(2)).catch((error) => {
  if (error && error.stderr) {
    const stderrText = error.stderr.toString().trim();
    if (stderrText) {
      console.error(`[db-backup] ${stderrText}`);
    }
  }
  console.error(`[db-backup] ${error.message}`);
  process.exit(1);
});
