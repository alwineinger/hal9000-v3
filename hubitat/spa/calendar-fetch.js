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

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    // khal is in user pip3 bin
    env: { ...process.env, PATH: process.env.PATH + ':/Users/oc_user/Library/Python/3.9/bin' },
  });
  if (result.status !== 0) {
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
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  const startStr = now.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  const format = '{uid}|{start-date}|{start-time}|{end-date}|{end-time}|{title}';
  const output = run('khal', ['list', startStr, endStr, '--format', format, '--day-format', '']);
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
        title: titleParts.join('|').trim(),
      };
    })
    .filter(Boolean);
}

/**
 * Build ISO datetime strings from khal date + time parts.
 */
function buildIsoDateTime(dateStr, timeStr) {
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
  return {
    uid: raw.uid,
    title: raw.title,
    start: buildIsoDateTime(raw.startDate, raw.startTime),
    end: buildIsoDateTime(raw.endDate, raw.endTime),
  };
}

// Main
const rawEvents = fetchAllEvents(days);
const normalized = rawEvents.map(normalizeEvent);

process.stdout.write(JSON.stringify(normalized, null, 2) + '\n');
