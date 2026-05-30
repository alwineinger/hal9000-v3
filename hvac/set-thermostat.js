#!/usr/bin/env node
const http = require('http');
const fs = require('fs');

const HUB_HOST = '10.40.1.227';
const APP_ID = '2321';
const TOKEN = fs.readFileSync('/Users/oc_user/.openclaw/secrets/hubitat-api-key.txt', 'utf8').trim().replace('access_token=', '');

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`http://${HUB_HOST}/apps/api/${APP_ID}${path}?access_token=${TOKEN}`);
    http.get({ hostname: u.hostname, port: u.port||80, path: u.pathname+'?'+u.searchParams.toString(), timeout:10000 }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(d.slice(0,300));} });
    }).on('error', reject).on('timeout',()=>reject(new Error('timeout')));
  });
}

function cmd(deviceId, command, args) {
  return new Promise((resolve, reject) => {
    const u = new URL(`http://${HUB_HOST}/apps/api/${APP_ID}/devices/${deviceId}/${command}?access_token=${TOKEN}`);
    if (args) u.searchParams.set('args', args);
    http.get({ hostname: u.hostname, port: u.port||80, path: u.pathname+'?'+u.searchParams.toString(), timeout:10000 }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(d.slice(0,300));} });
    }).on('error', reject).on('timeout',()=>reject(new Error('timeout')));
  });
}

async function main() {
  // Check what commands device 2189 supports (connector variable)
  const dev = await get('/devices/2189');
  console.log('Commands:', dev.commands?.join(', '));
  console.log('Attributes:', dev.attributes?.map(a=>`${a.name}=${a.currentValue}`).join(', '));
  console.log('Type:', dev.type);
  console.log('Driver:', dev.deviceNetworkId);
}
main().catch(e => console.error(e.message));
