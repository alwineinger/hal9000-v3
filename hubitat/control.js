#!/usr/bin/env node
/**
 * hubitat/control.js
 * Direct device control for Hubitat spa/pool automation.
 * Ported from openclaw-hal-ref with reconciled device IDs.
 *
 * Usage:
 *   node control.js list
 *   node control.js status <alias>
 *   node control.js set <alias> <on|off> [--confirm] [--allow-spillover]
 *   node control.js macro <spaHeatStart|spaHeatStop|poolNormal> --confirm [--allow-spillover]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const SPA_VALVE_SETTLE_MS = Number(process.env.SPA_VALVE_SETTLE_MS) || 5000;
const SPA_STEP_DELAY_MS   = Number(process.env.SPA_STEP_DELAY_MS)   || 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadToken() {
  if (process.env.HUBITAT_TOKEN) return process.env.HUBITAT_TOKEN;
  const defaultTokenPath = path.join(
    process.env.HOME || '/home/andy',
    '.openclaw/credentials/hubitat-token'
  );
  const tokenPath = process.env.HUBITAT_TOKEN_FILE || defaultTokenPath;
  if (fs.existsSync(tokenPath)) {
    const raw = fs.readFileSync(tokenPath, 'utf8').trim();
    // Support both raw tokens and "access_token=..." format
    return raw.startsWith('access_token=') ? raw.split('access_token=')[1] : raw;
  }
  console.error('Missing HUBITAT_TOKEN (set env or HUBITAT_TOKEN_FILE)');
  process.exit(1);
}

const token = loadToken();

const args = process.argv.slice(2);
const has  = (f) => args.includes(f);

// ── Maker API HTTP helpers ────────────────────────────────────────────────────

function apiGet(p) {
  return new Promise((resolve, reject) => {
    const fullPath =
      `/apps/api/${cfg.hub.appId}${p}${p.includes('?') ? '&' : '?'}access_token=${token}`;
    http.get({ host: cfg.hub.ip, path: fullPath, timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    }).on('error', reject);
  });
}

function apiPost(p) {
  return new Promise((resolve, reject) => {
    const fullPath = `/apps/api/${cfg.hub.appId}${p}?access_token=${token}`;
    const req = http.request({ host: cfg.hub.ip, path: fullPath, method: 'POST', timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Device reads ──────────────────────────────────────────────────────────────

async function getSwitch(alias) {
  const id = cfg.devices[alias];
  if (!id) throw new Error(`Unknown alias: ${alias}`);
  const data = await apiGet(`/devices/${id}/attribute/switch`);
  return data.value;
}

// ── Guardrails ────────────────────────────────────────────────────────────────

function isRisky(alias) {
  return cfg.guardrails.riskyAliases.includes(alias);
}

async function enforce(alias, cmd, opts = {}) {
  if (cfg.guardrails.requireConfirmForRisky && isRisky(alias) && !opts.confirm) {
    throw new Error(
      `Guardrail: '${alias} ${cmd}' is risky. Re-run with --confirm.`
    );
  }

  if (cfg.guardrails.enforceHeaterAutoNeedsPower && alias === 'heaterAuto' && cmd === 'on') {
    const power = await getSwitch('heaterPower');
    if (power !== 'on') {
      throw new Error('Guardrail: heaterAuto on blocked while heaterPower is off.');
    }
  }

  if (cfg.guardrails.requireModeExclusivity && !opts.allowSpillover) {
    if (alias === 'poolMode' && cmd === 'on') {
      const spa = await getSwitch('spaMode');
      if (spa === 'on') {
        throw new Error(
          "Guardrail: poolMode on blocked while spaMode is already on. Use --allow-spillover to override."
        );
      }
    }
    if (alias === 'spaMode' && cmd === 'on') {
      const pool = await getSwitch('poolMode');
      if (pool === 'on') {
        throw new Error(
          "Guardrail: spaMode on blocked while poolMode is already on. Use --allow-spillover to override."
        );
      }
    }
  }
}

// ── Device writes ─────────────────────────────────────────────────────────────

async function setSwitch(alias, cmd, opts = {}) {
  const id = cfg.devices[alias];
  if (!id) throw new Error(`Unknown alias: ${alias}`);
  await enforce(alias, cmd, opts);
  const result = await apiPost(`/devices/${id}/${cmd}`);
  return { alias, cmd, ok: true, result };
}

// ── Valve state helpers ────────────────────────────────────────────────────────

function interpretValveState(pool, spa) {
  if (pool === 'on'  && spa === 'off') return 'pool';
  if (pool === 'off' && spa === 'on')  return 'spa';
  if (pool === 'on'  && spa === 'on')  return 'overflow';
  return 'unknown';
}

async function getValveState() {
  const [pool, spa] = await Promise.all([
    getSwitch('poolMode').catch(() => 'unknown'),
    getSwitch('spaMode').catch(() => 'unknown'),
  ]);
  return { pool, spa, state: interpretValveState(pool, spa) };
}

/**
 * Drive the valve controller to a target state.
 * Retries up to 6 times, toggling spaMode to kick the actuator.
 */
async function ensureValveState(targetState, opts = {}) {
  const allowed = new Set(['pool', 'spa', 'overflow']);
  if (!allowed.has(targetState)) throw new Error(`Unsupported valve target '${targetState}'`);

  let info    = await getValveState();
  let attempts = 0;

  while (info.state !== targetState && attempts < 6) {
    // Turn spa off first to break any stuck state
    await setSwitch('spaMode', 'off', { ...opts, allowSpillover: true }).catch(() => null);
    await sleep(250);
    // Drive to target
    await setSwitch('spaMode', 'on', { ...opts, allowSpillover: true });
    attempts += 1;
    await sleep(SPA_VALVE_SETTLE_MS);
    info = await getValveState();
  }

  if (info.state !== targetState) {
    throw new Error(
      `Failed to reach valve state '${targetState}' (stuck at '${info.state}')`
    );
  }

  return { action: 'valveState', target: targetState, attempts, ok: true, final: info };
}

// ── Macros ─────────────────────────────────────────────────────────────────────

async function runMacro(name) {
  if (!has('--confirm')) {
    throw new Error(`Guardrail: macro '${name}' is operationally risky. Re-run with --confirm.`);
  }

  const opts = {
    confirm:       true,
    allowSpillover: has('--allow-spillover'),
  };

  const steps = [];

  if (name === 'spaHeatStart') {
    // Isolated spa heating: drive valves into spa position, then enable heater.
    steps.push(await ensureValveState('spa', opts));
    await sleep(SPA_STEP_DELAY_MS);
    steps.push(await setSwitch('heaterPower', 'on', opts));
    await sleep(SPA_STEP_DELAY_MS);
    steps.push(await setSwitch('heaterAuto',  'on', opts));
    return steps;
  }

  if (name === 'spaHeatStop') {
    // Stop spa heating and return to normal pool circulation.
    steps.push(await setSwitch('heaterAuto', 'off', opts));
    await sleep(SPA_STEP_DELAY_MS);
    steps.push(await ensureValveState('pool', opts));
    return steps;
  }

  if (name === 'poolNormal') {
    // Standard pool mode: no spa, no auto-heating.
    steps.push(await setSwitch('heaterAuto', 'off', opts));
    await sleep(SPA_STEP_DELAY_MS);
    steps.push(await ensureValveState('pool', opts));
    return steps;
  }

  if (name === 'officeFlash') {
    // Flash the office light 3 times.
    for (let i = 0; i < 3; i++) {
      steps.push(await setSwitch('officeLight', 'off', opts));
      await sleep(250);
      steps.push(await setSwitch('officeLight', 'on', opts));
      await sleep(250);
    }
    return steps;
  }

  throw new Error(
    `Unknown macro: ${name}. Available: spaHeatStart, spaHeatStop, poolNormal`
  );
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

async function main() {
  const command = args[0];

  if (command === 'list') {
    const devices = await apiGet('/devices');
    for (const d of devices) {
      console.log(`${d.id}\t${d.label}\t${d.type}\t${d.room || ''}`);
    }
    return;
  }

  if (command === 'status') {
    const alias  = args[1];
    const value  = await getSwitch(alias);
    console.log(`${alias}: ${value}`);
    return;
  }

  if (command === 'set') {
    const alias = args[1];
    const cmd   = args[2];
    if (!alias || !cmd || !['on', 'off'].includes(cmd)) {
      throw new Error(
        'Usage: set <alias> <on|off> [--confirm] [--allow-spillover]'
      );
    }
    const result = await setSwitch(alias, cmd, {
      confirm:       has('--confirm'),
      allowSpillover: has('--allow-spillover'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'macro') {
    const name = args[1];
    if (!name) {
      throw new Error(
        'Usage: macro <spaHeatStart|spaHeatStop|poolNormal> --confirm [--allow-spillover]'
      );
    }
    const steps = await runMacro(name);
    console.log(JSON.stringify({ macro: name, ok: true, steps }, null, 2));
    return;
  }

  throw new Error(
    'Usage: list | status <alias> | set <alias> <on|off> [--confirm] [--allow-spillover] | macro <name> --confirm'
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});