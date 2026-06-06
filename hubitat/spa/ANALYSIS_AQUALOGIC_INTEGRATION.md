# Aqualogic / PL-PLUS Direct Integration Analysis
**Date:** 2026-06-05  
**Analyst:** coding_specialist (subagent task)  
**Goal:** Integrate aqualogic Python library (or its PL-PLUS web bridge) as a supplemental or replacement data source for chlorinator %, salt, pump speed, and cleaner LED-based state.

---

## 1. Current Architecture (Hubitat Path)

### Read Path (monitor.js)
- Pure I/O boundary: `hubitat/monitor.js` exports `readSnapshot()`.
- Implementation: Parallel `http.get()` to Hubitat Maker API per device.
- Devices read per tick:
  - 2125 → spaTemp (attribute/temperature)
  - 2141 → spaMode (switch → 'on'/'off')
  - 2131 → heaterPower (switch)
  - 2137 → heaterRun (switch)
  - 2138 → heaterAuto (switch)
  - 2124 → poolTemp (bonus)
  - 1451 → ambientTemp (lanai under eave, preferred)
- Return shape:
  ```js
  {
    spaTempF, poolTempF, ambientF,
    valveState: 'on'|'off' (or 'spa'|'pool' in some logic),
    heaterPower, heaterRun, heaterAuto
  }
  ```
- Error handling: Per-read try/catch → null. No single call blows up snapshot.
- Polling: Stateless — called once per scheduler launchd tick (60 seconds). No connection reuse.

### Write Path (control.js)
- Macros (`spaHeatStart`, `spaHeatStop`) drive valves + heater relays via Maker API.
- Valve dance: `ensureValveState()` + 5s settle.
- Scheduler never reads during the actual heating — it only commands the three critical switches once; PL-PLUS (Hayward controller) owns the rest.
- Guardrails live here (risky aliases, heaterAuto requires power, mode exclusivity).

### Scheduler Consumption (scheduler.js)
- `const currentState = await readSnapshot();` — top of every tick.
- Uses:
  - `spaTempF` + `ambientF` → `calculateLeadMinutes()` (preheat.js)
  - `valveState === 'spa'|'on'` → `waitForValveReady()` (polling loop with one retry)
  - `valveState` again at event end to decide whether `spaHeatStop` is necessary
  - Passed to `buildPreheatSession()` / `updateSessionObservation()` → only records `spaTempF` today (observations array)
- No chlorinator, salt, or pump data ever touches the scheduler.

### Other Consumers
- `session.js` — only cares about spaTempF deltas for rate calculation.
- `preheat.js` — historical rate blending from `observedRateFPerHour`.
- Weather/approval/telegram paths are orthogonal (weather is OpenWeather fetch, not pool data).

**State files:** `data/spa-state.json`, `spa-preheat-history.json` (observations contain only temp data).

---

## 2. What Aqualogic/PL-PLUS Provides

From task brief and `skills/plplus/SKILL.md`:

### Web Bridge (current implemented surface at http://10.40.1.61:8089)
- `GET /api/display` → `{ lines: ["Pool Temp  84°F", ...], leds: { ... }, blink: [], updated_at }`
- Lines are human LCD text (temps, chlorinator %, salt PPM, speed % appear here).
- LEDs are the status bits: POOL, SPA, HEATER_1, FILTER, LIGHTS, AUX_1..14, etc.
- Keypress simulation via `POST /api/key/<plus|minus|menu|pool_spa|filter>` for navigation/control (read-only exploration only today).

### Python `aqualogic` Library (core.py per task)
- Structured access:
  - Temps: `pool_temp`, `spa_temp`, `air_temp` (configurable °F/°C)
  - Chlorinator: `pool_chlorinator%`, `spa_chlorinator%`
  - Salt: `salt_level` (PPM or g/L)
  - Pump: `pump_speed%`, `pump_power` (watts)
  - LEDs / flags: POOL/SPA/HEATER_1/FILTER bits; `is_heater_enabled()`, `is_super_chlorinate_enabled()`, `check_system_msg()`

### Current Reality in HAL
- Hubitat already has an RS485 aqualogic driver that mirrors much of this into virtual devices (hence device 2125, 2141, 2131 etc.).
- The plplus web server is a separate Flask bridge (likely wrapping the same serial protocol) for direct HTTP access.
- Goal of this task: bypass or supplement the Hubitat hop for fresher/more detailed data (especially % values that Hubitat may not expose cleanly).

---

## 3. Integration Point Design

**Recommended: Parallel supplemental reader + merge (not a full replacement).**

### Why not "delete monitor.js"?
- Control path **still goes through Hubitat** (`control.js` macros). The PL-PLUS web interface only offers keypress simulation — no direct "set heater on + valve spa" atomic command. Commands remain safest via the existing guardrail'd macros.
- Hubitat virtuals (heaterAuto, heaterRun mirror, mode exclusivity logic) may still be authoritative for some state.
- Existing monitor.js is tiny, well-understood, and the fallback path if the web bridge is down.

### Proposed shape
1. **New module:** `hubitat/spa/plplus-reader.js`
   - Exports `readPlPlusSnapshot()` (or `readDirectSnapshot()`).
   - For now: HTTP fetch to `PLPLUS_BASE_URL/api/display` (env-driven).
   - Future: `spawn('python', ['-m', 'aqualogic.cli', 'status', '--json'])` or import the lib directly if Node can bridge.
   - Normalize:
     ```js
     {
       // Existing contract (for zero scheduler changes)
       spaTempF: Number,
       poolTempF: Number,
       ambientF: Number,
       valveState: 'spa' | 'pool' | 'unknown',
       heaterPower: 'on'|'off',
       heaterRun: 'on'|'off',
       heaterAuto: 'on'|'off',   // may synthesize or leave null

       // NEW FIELDS (additive, no existing code depends on them yet)
       saltPpm: Number,
       spaChlorinatorPct: Number,
       poolChlorinatorPct: Number,
       pumpSpeedPct: Number,
       pumpPowerW: Number,
       rawLeds: { SPA: true, POOL: false, HEATER_1: ..., ... },
       systemMsg: string | null,
       superChlorinate: bool
     }
     ```

2. **Merge strategy in scheduler.js** (one call site change):
   ```js
   const hubitatState = await readSnapshot().catch(e => { runLog(...); return null; });
   const plState = await readPlPlusSnapshot().catch(() => null);
   const currentState = mergePlPlusIntoHubitat(hubitatState, plState);
   // pl wins for spaTempF/poolTempF/ambientF/valveState; Hubitat wins for heater* if needed; always add salt/chlor/pump
   ```
   - Implement `merge...()` in plplus-reader.js or a tiny utils.
   - Full backwards compatibility — code that only reads `.spaTempF` etc. keeps working.

3. **Config** (`config.js` or new env):
   - `PLPLUS_URL=http://10.40.1.61:8089`
   - `SPA_DATA_SOURCE=hubitat,plplus` (future selector if we ever want to deprecate one)

### Data mapping notes (valve/LED)
- Hubitat `spaMode` switch: 'on' means "spa valve position / isolated spa loop".
- PL-PLUS LED: `leds.SPA === true` (or LED bitmask) or `leds.POOL === true`.
  - Normalize rule:
    ```js
    if (leds?.SPA) valveState = 'spa';
    else if (leds?.POOL) valveState = 'pool';
    else if (hubitatState?.valveState) valveState = hubitatState.valveState; // fallback
    else 'unknown';
    ```
- Heater: `is_heater_enabled()` or `leds.HEATER_1` → `heaterRun`.
- `heaterPower` and `heaterAuto` are Hubitat-side virtuals (Aux2 relay + the "Auto" flag). PL-PLUS may report "Heater1 Manual On/Off" in diagnostic lines. For control we still trust Hubitat's view; for observation, PL-PLUS LED is fine.
- Temps: Direct match. Confirm unit (web /api/display always shows "84°F"; Python lib may be configurable — reader should normalize to F).

### Call sites that remain untouched
- `waitForValveReady()` — still works because normalized `valveState` will be 'spa'.
- `runSpaMacro()` — unchanged (goes through control.js).
- All pure modules (preheat, session, approval, weather) — they only see the merged snapshot.

---

## 4. What Changes / What Breaks

### No breakage to existing logic
- Core state machine, weather approval, lead-time model, valve transit polling, history recording, and finalization paths are **insensitive** to chlorinator/salt/pump.
- They only need reliable spaTempF + valveState + heater binaries — which the merged reader will continue to provide.

### New/enhanced capabilities (additive)
- Session observations can optionally capture `saltPpm`, `chlorinatorPct`, `pumpSpeedPct` at each tick (future diagnostic value: "was salt low during slow heat?" or "pump at 40% while heating?").
- Telegram alerts could include salt/chlor status (e.g., "Spa heating started, salt 2950 PPM, chlorinator 30%").
- Preheat history becomes much richer for ML refinement later.
- Could add future guard: "skip preheat if salt < 2500 PPM" (business logic addition, not required for basic integration).

### What would actually need scheduler edits (small)
- If we record new fields in observations: 1-2 lines in `buildPreheatSession()` and `updateSessionObservation()`.
- If we want to surface in logs/telemetry: touches to `runLog` sites and `telegram.js` message builders (optional).
- Valve confirmation logic already resilient (re-calls spaHeatStart on mismatch). Direct PL-PLUS reads may expose more precise "valve in transit" states from LEDs.

### Potential new failure modes (and mitigation)
- Web bridge down → merge falls back to Hubitat-only data (no temp? → leadMinutes defaults to 60 min).
- LED vs Hubitat valve state drift → scheduler still has the existing 30s poll + retry path.
- Unit mismatch (°C from Python lib) → reader must canonicalize to °F.
- Auth / CORS / network locality: PL-PLUS web is LAN-only (same risk surface as Hubitat).

---

## 5. Scope Estimate

**Minimal viable integration (planning → working reads):**
- 1 new file: `hubitat/spa/plplus-reader.js` (~80-120 LOC)
- 1 small edit: `hubitat/spa/scheduler.js` (import + merge at the single `readSnapshot` call site, plus one env/config line)
- 1 optional tiny edit: expose new fields in session observations (if desired immediately)
- Config/docs: 5 lines in `config.js` + update DESIGN.md + this analysis doc
- Testing: add to `test-smoke.js`; one manual run with real bridge up

**Total:** Effectively a **2-3 file change** for the data path. Control path (Hubitat) untouched. State machine unchanged.

**If we also want history enrichment + Telegram surfacing:** +3 small edits (session.js, scheduler log points, telegram.js) → still < 6 touched files.

**Not in scope for this integration:**
- Replacing the control macros (would require either (a) expanding the PL-PLUS web API with direct command endpoints, or (b) accepting that keypress sequences are lossy and non-atomic).
- Full deprecation of Hubitat monitor (keep the parallel path for at least 1-2 seasons of cross-validation).
- Any change to launchd plists, calendar, or weather.

---

## 6. Recommended Phasing

**Phase 0 (this analysis):** Done.
**Phase 1 (read-only visibility):**
- Implement plplus-reader.js (fetch + parse lines/leds → normalized shape).
- Wire merge in scheduler.
- Log the new fields on every tick.
- Populate (but don't break) history observations.

**Phase 2 (enrichment):**
- Use salt/pump in a new diagnostic Telegram at preheat start.
- Add optional "salt too low" soft warning (no blocking behavior yet).

**Phase 3 (future optional):**
- If PL-PLUS web grows real control endpoints, evaluate dual-control or migration.
- Or keep Hubitat as the "command authority" and PL-PLUS as the high-frequency sensor.

---

## 7. Open Questions / Next Steps for Main Agent

1. Is the Python `aqualogic` core.py already runnable in the current venv, or is the web bridge the only live surface today?
2. Confirm the exact LED key names and temp units coming off `/api/display` in the current PL-PLUS deployment (one `curl` during a real run).
3. Decide whether we want `saltPpm` / `pumpSpeedPct` persisted into `spa-preheat-history.json` immediately, or start with just console/log emission.
4. Any appetite to make the data source selectable (`SPA_SENSOR_SOURCE=hubitat|plplus|both`) for A/B testing?

**This is a low-risk, high-visibility win.** The architecture is already cleanly separated at the `readSnapshot()` boundary, and the control surface remains Hubitat (safe). Adding direct reads primarily gives better data for the existing lead-time model and future observability without touching the fragile valve/heater dance.

