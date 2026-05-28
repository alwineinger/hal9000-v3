#!/usr/bin/env node
/**
 * hubitat/monitor.js
 * Reads current spa/pool device state from Hubitat via Maker API.
 */

const fetch = require('node:http');

// Config — these are read from env or defaults
const HUB_HOST = process.env.HUBITAT_HUB_HOST || '10.40.1.227';
const HUB_APP_ID = process.env.HUBITAT_APP_ID || '2321';
const HUB_TOKEN = process.env.HUBITAT_ACCESS_TOKEN || '108c58a4-aeff-4301-9610-7dd56b40a035';

const BASE_URL = `http://${HUB_HOST}/apps/api/${HUB_APP_ID}`;
const TOKEN_PARAM = `access_token=${HUB_TOKEN}`;

// Device IDs
const DEVICES = {
  spaTemp:     2125,  // temperature
  spaMode:     2141,  // switch (on=spa, off=pool)
  heaterPower: 2131,  // switch
  heaterRun:   2137,  // switch
  heaterAuto:  2138,  // switch
  poolTemp:    2124,  // temperature (bonus)
  ambientTemp: 2126,  // air temp (bonus)
};

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}?${TOKEN_PARAM}`;
    const [hostPort, rest] = url.replace('http://', '').split('/', 1);
    const [host, port] = hostPort.split(':');
    const options = {
      hostname: host,
      port: port || 80,
      path: '/' + rest,
      method: 'GET',
      timeout: 10000,
    };
    const req = require('http').get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Failed to parse JSON from ${path}: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${path}`)); });
  });
}

async function readAttribute(deviceId, attribute) {
  try {
    const data = await httpGet(`/devices/${deviceId}/attribute/${attribute}`);
    return data[attribute] ?? null;
  } catch {
    return null;
  }
}

async function readSwitch(deviceId) {
  try {
    const data = await httpGet(`/devices/${deviceId}`);
    const attr = data.attributes?.find(a => a.name === 'switch');
    return attr?.currentValue ?? null;
  } catch {
    return null;
  }
}

async function readSnapshot() {
  const [spaTemp, spaMode, heaterPower, heaterRun, heaterAuto, poolTemp, ambientTemp] = await Promise.all([
    readAttribute(DEVICES.spaTemp, 'temperature'),
    readSwitch(DEVICES.spaMode),
    readSwitch(DEVICES.heaterPower),
    readSwitch(DEVICES.heaterRun),
    readSwitch(DEVICES.heaterAuto),
    readAttribute(DEVICES.poolTemp, 'temperature'),
    readAttribute(DEVICES.ambientTemp, 'temperature'),
  ]);

  const spaTempF = spaTemp !== null ? Number(spaTemp) : null;
  const ambientF = ambientTemp !== null ? Number(ambientTemp) : null;

  return {
    spaTempF,
    poolTempF: poolTemp !== null ? Number(poolTemp) : null,
    ambientF,
    valveState: spaMode,
    heaterPower,
    heaterRun,
    heaterAuto,
  };
}

// CLI fallbacks
if (require.main === module) {
  readSnapshot().then(state => {
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { readSnapshot };