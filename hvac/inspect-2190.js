#!/usr/bin/env node
const http = require('http');
const fs = require('fs');

const HUB_HOST = '10.40.1.227';
const APP_ID = '2321';
const TOKEN = ***'/Users/oc_user/.openclaw/secrets/hubitat-api-key.txt', 'utf8').trim().replace('access_token=', '');

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`http://${HUB_HOST}/apps/api/${APP_ID}${path}?access_token=***
    http.get({ hostname: u.hostname, port: u.port||80, path: u.pathname+'?'+u.searchParams.toString(), timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d.slice(0, 500)); } });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

async function main() {
  const dev = await get('/devices/2190');
  console.log('Name:', dev.name);
  console.log('Label:', dev.label);
  console.log('Attributes:', JSON.stringify(dev.attributes?.map(a => ({ name: a.name, value: a.currentValue })), null, 2));
  console.log('Commands:', dev.commands?.join(', '));
}
main().catch(e => console.error(e.message));
