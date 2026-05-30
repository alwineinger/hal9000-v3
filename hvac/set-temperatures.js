#!/usr/bin/env node
const http = require('http');
const fs = require('fs');

const HUB_HOST = '10.40.1.227';
const APP_ID = '2321';
const TOKEN = fs.readFileSync('/Users/oc_user/.openclaw/secrets/hubitat-api-key.txt', 'utf8').trim().replace('access_token=', '');

function setVar(deviceId, value) {
  return new Promise((resolve, reject) => {
    const u = new URL('http://' + HUB_HOST + '/apps/api/' + APP_ID + '/devices/' + deviceId + '/setVariable?access_token=' + TOKEN);
    u.searchParams.set('args', String(value));
    http.get({ hostname: u.hostname, port: u.port||80, path: u.pathname+'?'+u.searchParams.toString(), timeout: 15000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 100) }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

async function main() {
  for (const [id, name, val] of [[2189,'thermawaycool',80],[2190,'thermdaycool',77],[2193,'thermdayheat',72],[2191,'thermnightcool',73]]) {
    process.stdout.write(name + ' -> ' + val + '... ');
    const r = await setVar(id, val);
    console.log(r.status, r.body);
  }
}
main().catch(e => console.error(e.message));
