#!/usr/bin/env node
const http = require('http');
const fs = require('fs');

const HUB_HOST = '10.40.1.227';
const APP_ID = '2321';
const TOKEN = fs.readFileSync('/Users/oc_user/.openclaw/secrets/hubitat-api-key.txt', 'utf8').trim().replace('access_token=', '');

function setVariable(deviceId, value) {
  return new Promise((resolve, reject) => {
    const u = new URL(`http://${HUB_HOST}/apps/api/${APP_ID}/devices/${deviceId}/setVariable?access_token=${TOKEN}`);
    u.searchParams.set('args', String(value));
    http.get({ hostname: u.hostname, port: u.port||80, path: u.pathname+'?'+u.searchParams.toString(), timeout: 15000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ deviceId, value, status: res.statusCode, body: d.slice(0,100) }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

async function main() {
  const changes = [
    { deviceId: 2189, variable: 'thermawaycool', value: 80 },
    { deviceId: 2190, variable: 'thermdaycool',  value: 77 },
    { deviceId: 2193, variable: 'thermdayheat',  value: 72 },
    { deviceId: 2191, variable: 'thermnightcool', value: 73 },
  ];

  for (const c of changes) {
    process.stdout.write(`Setting ${c.variable} (device ${c.deviceId}) → ${c.value}°F... `);
    try {
      const r = await setVariable(c.deviceId, c.value);
      console.log(`→ ${r.status}: ${r.body || 'ok'}`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }
  console.log('Done.');
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
