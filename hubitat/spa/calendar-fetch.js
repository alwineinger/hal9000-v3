#!/usr/bin/env node
/**
 * calendar-fetch.js
 * Fetches calendar events using khal (from caldav-calendar skill) and filters for "Spa" events.
 *
 * Usage:
 *   node calendar-fetch.js [--days N]
 *
 * Environment:
 *   SPA_CALENDAR_DAYS  — look-ahead window in days (default: 2)
 *
 * Output: JSON array of { title, start, end, uid } to stdout
 *         Empty array if no events found.
 */

const { spawnSync } = require('child_process');
const path = require('path');

// Resolve SPA_CALENDAR_DAYS from env, or allow CLI override
const DEFAULT_DAYS = 2;
const cliDays = process.argv.includes('--days')
  ? parseInt(process.argv[process.argv.indexOf('--days') + 1], 10)
  : NaN;
const days = Number.isFinite(cliDays) ? cliDays : Number(process.env.SPA_CALENDAR_DAYS || DEFAULT_DAYS);

const ROOT = path.resolve(__dirname, '..', '..');

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  // khal exits 0 on success, even with no events; non-zero only on real errors
  if (result.status !== 0 && result.status !== 0) {
    // Treat non-zero exit as error; stderr may have diagnostic info
    const msg = result.stderr || result.stdout || `khal exited with ${result.status}`;
    console.error('[calendar-fetch] khal error:', msg);
    return '';
  }
  return (result.stdout || '').trim();
}

/**
 * Fetch all events from khal for the next N days.
 * Uses pipe-delimited format: uid|start-date|start-time|end-date|end-time|title
 *
 * Returns an array of raw parsed rows (may include empty/invalid lines).
 */
function fetchAllEvents(days) {
  // khal list accepts "today Nd" or just "Nd" for next N days
  const rangeArg = `today ${days}d`;
  const format = '{uid}|{start-date}|{start-time}|{end-date}|{end-time}|{title}';

  const output = run('khal', ['list', '--format', format, rangeArg]);
  if (!output) return [];

  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split('|');
      if (parts.length < 6) return null;
      const [uid, startDate, startTime, endDate, endTime, ...titleParts] = parts;
      return {
        uid: uid.trim(),
        startDate: startDate.trim(),
        startTime: startTime.trim(),
        endDate: endDate.trim(),
        endTime: endTime.trim(),
        title: titleParts.join('|').trim(), // title may contain pipe chars
      };
    })
    .filter(Boolean);
}

/**
 * Build ISO datetime strings from khal date + time parts.
 * khal uses locale-formatted dates/times as configured in khal config.
 * We reconstruct ISO strings: start = "YYYY-MM-DD HH:MM", end = "YYYY-MM-DD HH:MM"
 */
function buildIsoDateTime(dateStr, timeStr) {
  // timeStr may be "HH:MM" or empty for all-day events
  if (!timeStr || timeStr === '00:00') {
    return `${dateStr}T00:00:00`;
  }
  return `${dateStr}T${timeStr}:00`;
}

/**
 * Normalize a calendar event into the shape expected by scheduler.js:
 * { title, start, end, uid }
 */
function normalizeEvent(raw) {
  const start = buildIsoDateTime(raw.startDate, raw.startTime);
  const end = buildIsoDateTime(raw.endDate, raw.endTime);
  return {
    uid: raw.uid,
    title: raw.title,
    start,
    end,
  };
}

// Main
const rawEvents = fetchAllEvents(days);
const normalized = rawEvents.map(normalizeEvent);

process.stdout.write(JSON.stringify(normalized, null, 2) + '\n');
