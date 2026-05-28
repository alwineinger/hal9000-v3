#!/usr/bin/env node
/**
 * spa-calendar.js (legacy entry point)
 *
 * This file is now a thin shim that delegates to the refactored scheduler
 * in ./spa/scheduler.js. All logic has been moved into pure modules under
 * hubitat/spa/ to eliminate any LLM dependency except the explicit Telegram
 * weather approval path.
 *
 * Existing cron jobs, environment variables, and file paths continue to work.
 */

const { main } = require('./spa/scheduler');

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main };
