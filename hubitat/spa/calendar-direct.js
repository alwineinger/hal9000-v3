#!/usr/bin/env node
/**
 * calendar-direct.js
 * Direct iCloud CalDAV client — no vdirsyncer/khal dependency.
 * Uses @xmldom/xmldom for XML + node-ical for ICS parsing.
 *
 * Usage:
 *   node calendar-direct.js [--days N]
 *
 * Environment:
 *   APPLE_ICLOUD_USER        — iCloud username (default: oc_wineinger@icloud.com)
 *   APPLE_CALDAV_APP_PW_FILE — path to app-specific password
 *                              (default: /Users/oc_user/.openclaw/secrets/apple-caldav-app-pw.txt)
 *   SPA_CALENDAR_UUID        — calendar UUID to query directly
 *                              (default: ee18efda04276d12c4ff80782c8aad44fc2e4df9d6bb4bbb90f6fe991a9594b0)
 *
 * Output: JSON array of { uid, title, start, end } to stdout.
 */

const { spawnSync } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────────
const ICLOUD_USER = process.env.APPLE_ICLOUD_USER || 'oc_wineinger@icloud.com';
const PW_FILE     = process.env.APPLE_CALDAV_APP_PW_FILE
                    || '/Users/oc_user/.openclaw/secrets/apple-caldav-app-pw.txt';
const CALDAV_BASE = 'https://caldav.icloud.com';

const DEFAULT_DAYS = 2;

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : def;
};
const days = parseInt(getArg('--days', ''), 10) || DEFAULT_DAYS;

// ── Auth ─────────────────────────────────────────────────────────────────────
function getPassword() {
  try {
    return spawnSync('cat', [PW_FILE], { encoding: 'utf8' }).stdout.trim();
  } catch {
    console.error('[calendar-direct] Cannot read password file:', PW_FILE);
    process.exit(1);
  }
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
function caldav(method, url, body, depth) {
  depth = depth !== undefined ? depth : 1;
  const auth = `${ICLOUD_USER}:${getPassword()}`;
  const args = ['-s', '-S', '--request', method, '-u', auth,
                '-H', 'Content-Type: text/xml; charset=utf-8',
                '-H', `Depth: ${depth}`];
  if (body) args.push('-d', body);
  args.push(url);

  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`curl ${method} ${url} → ${r.status}: ${r.stderr}`);
  }
  return (r.stdout || '').trim();
}

// ── XML helpers (using @xmldom/xmldom) ──────────────────────────────────────
const { DOMParser } = require('@xmldom/xmldom');

function parseXml(xmlStr) {
  if (!xmlStr || !xmlStr.trim()) return null;
  const parser = new DOMParser();
  return parser.parseFromString(xmlStr, 'application/xml');
}

/**
 * Get text content of a namespaced element found anywhere under parent.
 */
function xmlDescendantText(parentEl, tagName) {
  const list = parentEl.getElementsByTagName(tagName);
  if (list.length) return list[0].textContent.trim();
  return null;
}

/**
 * Get text from a property inside successful propstat on a response.
 * e.g. displayname lives under propstat > prop, not directly under response.
 */
function propFromResponse(responseEl, propName) {
  const propstats = responseEl.getElementsByTagName('propstat');
  for (let i = 0; i < propstats.length; i++) {
    const ps = propstats[i];
    // Check this is a successful propstat (status 200)
    const statusEls = ps.getElementsByTagName('status');
    let ok = false;
    for (let j = 0; j < statusEls.length; j++) {
      if (statusEls[j].textContent.includes('200')) { ok = true; break; }
    }
    if (!ok) continue;
    // Look for prop element and then the property inside it
    const propEls = ps.getElementsByTagName('prop');
    for (let j = 0; j < propEls.length; j++) {
      const propEls2 = propEls[j].getElementsByTagName(propName);
      if (propEls2.length) return propEls2[0].textContent.trim();
    }
  }
  return null;
}

/**
 * Get href of a response block; prefers direct-child href.
 */
function hrefFromResponse(responseEl) {
  const hrefEls = responseEl.getElementsByTagName('href');
  for (let i = 0; i < hrefEls.length; i++) {
    const el = hrefEls[i];
    if (el.parentNode === responseEl) return el.textContent.trim();
  }
  return hrefEls[0] ? hrefEls[0].textContent.trim() : null;
}

// ── Step 1: discover principal URL ─────────────────────────────────────────
function step1_discoverPrincipal() {
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
  const resp = caldav('PROPFIND', `${CALDAV_BASE}/`, body, 0);
  const doc = parseXml(resp);
  const principalEls = doc.getElementsByTagName('current-user-principal');
  if (!principalEls.length) throw new Error('No current-user-principal in response');
  const hrefEls = principalEls[0].getElementsByTagName('href');
  if (!hrefEls.length) throw new Error('No href inside current-user-principal');
  const href = hrefEls[0].textContent.trim();
  if (href.startsWith('http')) return href;
  return `${CALDAV_BASE}${href}`;
}

// ── Step 2: get calendar-home-set ─────────────────────────────────────────
function step2_calendarHome(principalUrl) {
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:prop><c:calendar-home-set/></d:prop></d:propfind>';
  const resp = caldav('PROPFIND', principalUrl, body, 0);
  const doc = parseXml(resp);
  const homeSetEls = doc.getElementsByTagName('calendar-home-set');
  if (!homeSetEls.length) throw new Error('No calendar-home-set in response');
  const hrefEls = homeSetEls[0].getElementsByTagName('href');
  if (!hrefEls.length) throw new Error('No href inside calendar-home-set');
  const href = hrefEls[0].textContent.trim();
  if (href.startsWith('http')) return href;
  return `${CALDAV_BASE}${href}`;
}

// ── Step 3: list calendars ─────────────────────────────────────────────────
function step3_listCalendars(homeUrl) {
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';
  const resp = caldav('PROPFIND', homeUrl, body, 1);
  const doc = parseXml(resp);
  if (!doc) throw new Error('Empty response from calendar home PROPFIND');
  const responses = doc.getElementsByTagName('response');
  const cals = [];
  for (let i = 0; i < responses.length; i++) {
    const respEl = responses[i];
    const href = hrefFromResponse(respEl);
    if (!href) continue;
    // Skip system collections
    if (href.endsWith('/inbox') ||
        href.endsWith('/outbox') ||
        href.includes('/notification')) continue;
    const name = propFromResponse(respEl, 'displayname') || '';
    if (!name) continue; // skip system collections without displayname
    const url = href.startsWith('http') ? href : `${CALDAV_BASE}${href}`;
    cals.push({ name, url });
  }
  return cals;
}

// ── Step 4: query events via calendar-query REPORT ──────────────────────────
function toCalDAVTime(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function step4_queryEvents(calUrl, start, end) {
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
    '<c:filter>' +
    '<c:comp-filter name="VCALENDAR">' +
    '<c:comp-filter name="VEVENT">' +
    `<c:time-range start="${toCalDAVTime(start)}" end="${toCalDAVTime(end)}"/>` +
    '</c:comp-filter>' +
    '</c:comp-filter>' +
    '</c:filter>' +
    '</c:calendar-query>';
  const xml = caldav('REPORT', calUrl, body);
  return xml;
}

// ── ICS parsing (using node-ical) ──────────────────────────────────────────
const nodeIcal = require('node-ical');

/**
 * Extract VEVENTs from a CalDAV multistatus XML response.
 * Each <calendar-data> block may contain CDATA-wrapped ICS; node-ical parses it.
 */
function extractEventsFromMultiStatus(xml) {
  const doc = parseXml(xml);
  if (!doc) return [];
  const responses = doc.getElementsByTagName('response');
  const allParsed = [];

  for (let i = 0; i < responses.length; i++) {
    const respEl = responses[i];
    const calDataEls = respEl.getElementsByTagName('calendar-data');
    if (!calDataEls.length) continue;
    const calDataEl = calDataEls[0];

    // Extract CDATA section content specifically
    let ics = '';
    for (let n = 0; n < calDataEl.childNodes.length; n++) {
      const node = calDataEl.childNodes[n];
      if (node.nodeType === 4) { // CDATA_SECTION_NODE
        ics = node.textContent;
        break;
      }
    }
    // Fallback: plain textContent
    if (!ics) ics = calDataEl.textContent || '';

    if (!ics.trim()) continue;

    try {
      const parsed = nodeIcal.parseICS(ics);
      for (const [key, val] of Object.entries(parsed)) {
        if (key === 'vcalendar' || !val || typeof val !== 'object') continue;
        if (val.type === 'VEVENT') {
          allParsed.push({ key, val });
        }
      }
    } catch (e) {
      console.error('[calendar-direct] parseICS error:', e.message);
    }
  }
  return allParsed;
}

// ── Normalize event ─────────────────────────────────────────────────────────
/**
 * Unwrap summary from node-ical (handles both plain string and
 * { params: { LANGUAGE: 'en-US' }, val: 'text' } objects).
 */
function unwrapSummary(val) {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && 'val' in val) return val.val;
  return String(val || '');
}

/**
 * Format a date as YYYY-MM-DDTHH:MM:SS.
 * Handles node-ical's dateOnly flag by using just the date part + midnight.
 */
function fmtDate(d, defaultTime) {
  if (!d) return null;
  // d may be a Date or a node-ical wrapper { dateOnly: true }
  const isWrapper = d && typeof d === 'object' && ! (d instanceof Date);
  const dateObj = isWrapper ? null : (d instanceof Date ? d : new Date(d));
  if (dateObj && !isNaN(dateObj)) {
    return dateObj.toISOString();
  }
  return null;
}

/**
 * Normalize an event key+val into { uid, title, start, end }.
 * Matches the contract of calendar-fetch.js: ISO datetime strings.
 */
function normalizeEvent(key, val) {
  // Title
  let title = unwrapSummary(val.summary || val.description);

  // Start
  let startStr = '';
  if (val.start) {
    const isDateOnly = val.datetype === 'date';
    if (isDateOnly) {
      // For all-day events, use date portion only
      const s = new Date(val.start);
      if (!isNaN(s)) startStr = s.toISOString().slice(0, 10) + 'T00:00:00';
    } else {
      const s = new Date(val.start);
      if (!isNaN(s)) startStr = s.toISOString();
    }
  }

  // End
  let endStr = '';
  if (val.end) {
    const isDateOnly = val.datetype === 'date';
    if (isDateOnly) {
      const e = new Date(val.end);
      if (!isNaN(e)) endStr = e.toISOString().slice(0, 10) + 'T23:59:59';
    } else {
      const e = new Date(val.end);
      if (!isNaN(e)) endStr = e.toISOString();
    }
  }

  return {
    uid:    val.uid || key,
    title,
    start:  startStr,
    end:    endStr,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const now    = new Date();
  const later  = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // 1. discover principal
  let principal;
  try {
    principal = step1_discoverPrincipal();
    console.error('[calendar-direct] Step 1 principal:', principal);
  } catch (e) { console.error('[calendar-direct] Step 1 failed:', e.message); process.exit(1); }

  // 2. calendar home
  let home;
  try {
    home = step2_calendarHome(principal);
    console.error('[calendar-direct] Step 2 calendar home:', home);
  } catch (e) { console.error('[calendar-direct] Step 2 failed:', e.message); process.exit(1); }

  // 3. list calendars
  let calendars;
  try {
    calendars = step3_listCalendars(home);
    console.error(`[calendar-direct] Step 3: ${calendars.length} calendar(s):`);
    calendars.forEach(c => console.error(`         "${c.name}" → ${c.url}`));
  } catch (e) { console.error('[calendar-direct] Step 3 failed:', e.message); process.exit(1); }

  // 4. query all calendars for events
  console.error(`[calendar-direct] Step 4: querying all calendars, ${now.toISOString()} → ${later.toISOString()}`);
  const allEvents = [];
  for (const cal of calendars) {
    try {
      const xml = step4_queryEvents(cal.url, now, later);
      const extracted = extractEventsFromMultiStatus(xml);
      if (extracted.length) {
        console.error(`         "${cal.name}": ${extracted.length} event(s)`);
        for (const { key, val } of extracted) {
          allEvents.push(normalizeEvent(key, val));
        }
      }
    } catch (e) {
      console.error(`         "${cal.name}" query failed: ${e.message}`);
    }
  }

  // 5. filter for "Spa" events
  const matched = allEvents.filter(e => e.title.toLowerCase() === 'spa');
  console.error(`[calendar-direct] Total: ${allEvents.length} event(s), ${matched.length} "Spa" event(s)`);
  process.stdout.write(JSON.stringify(matched, null, 2) + '\n');
}

main().catch(e => { console.error('[calendar-direct] Fatal:', e.message); process.exit(1); });
