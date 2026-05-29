# HVAC Monitoring — Goals & Plan

**Date:** 2026-05-29
**Context:** Telegram DM with Andy Wineinger

---

## Current State

### What HAL can access (device 1806 — Honeywell T6 Pro Thermostat)

| Attribute | Available | Notes |
|-----------|-----------|-------|
| Temperature (interior) | ✅ | Currently 77.5°F |
| Cooling/heating setpoints | ✅ | Cool: 76°F, Heat: 73°F |
| Thermostat operating state | ✅ | cooling / heating / idle |
| Humidity | ✅ | 57–58% |
| Fan mode | ✅ | auto |
| Battery | ✅ | 95% |
| Supply/return air temps | ❌ | Not exposed |
| Compressor runtime counters | ❌ | Not exposed |
| Runtime history | ❌ | Not exposed |

### Existing exterior sensors

| Device | Location | Use |
|--------|----------|-----|
| 1451 | Lanai temp/humidity (under eave) | Preferred ambient exterior reading |
| 2126 | Equipment pad air temp | Sun-spiked, not useful as exterior reference |

---

## Goal 1 — HVAC Equipment Performance / Service Condition

### What's needed for delta T monitoring

- **Supply air temp** — cool air leaving the ductwork
- **Return air temp** — warm air coming back
- **Delta T** = return − supply. Healthy range: **14–20°F**. Below ~12°F indicates a problem (low refrigerant, dirty coil, restricted airflow).

### Assessment

With supply + return + exterior ambient, I can build a real-time delta T dashboard and flag degradation over time. Room-specific interior temps are **not needed** for this goal.

### What's still missing

- Supply and return air temp sensors wired to Hubitat (physical hardware)
- Compressor runtime per cycle — useful for detecting longer-than-normal runs indicating degradation
- Condenser discharge temperature for deeper service diagnostics

### Action items

- [ ] Install supply and return air temp sensors wired to Hubitat
- [ ] Check if Hubitat UI shows any hidden runtime attributes on device 1806 (driver may expose more via a different attribute group)
- [ ] Confirm whether the standard Hubitat Honeywell T6 Pro driver supports runtime counters or if a custom driver is needed

---

## Goal 2 — HVAC Sizing, Ducting, and Scheduling Suitability

### What's needed

- **Room-specific interior temperatures** throughout the house
- Without this, I cannot answer:
  - Is the system keeping up in back bedrooms vs front living areas?
  - Are some rooms never reaching setpoint?
  - Is the system oversized (short cycles, poor dehumidification) or undersized?
  - Is scheduling leaving certain rooms unattended?

### Assessment

Room-level sensors would enable:
- Temperature gradient mapping across the house during peak load
- Distribution problem detection (rooms 3°+ warmer than others)
- Identification of scheduling gaps
- Sizing evaluation based on how quickly rooms recover after cycles

### Action items

- [ ] Identify existing temperature sensors in Hubitat not yet exposed to HAL
- [ ] Determine how many rooms/zones need coverage (minimum 4–6 strategically placed sensors)
- [ ] Assess whether Andy's current sensor deployment can support this goal

---

## What HAL Needs to Make This Work

### For Goal 1 (Delta T)

1. Supply air temp sensor (wired to Hubitat)
2. Return air temp sensor (wired to Hubitat)
3. Exterior ambient (device 1451 covers this)

### For Goal 2 (Room Analysis)

1. 4–6 room temperature sensors distributed across the house
2. Consistent polling (could be every 5–10 min via hubitat/monitor.js)

### Software integration (HAL-side)

- Extend `hubitat/monitor.js` to read new sensor devices
- Store time-series data in `data/hvac-performance.json` (new file, gitignored)
- Build lightweight analysis: daily delta T trends, room temp variance, cycle runtime tracking
- No new npm dependencies needed

---

## Hubitat Repository Findings (2026-05-29)

Searched `alwineinger/hubitat` and `alwineinger/Hubitat-alw` on GitHub:

- **No thermostat driver code found** in these repos — the T6 Pro is running the standard Hubitat driver
- `alwineinger/Hubitat-alw/apps/hvac-pause-on-open-contacts` — pauses HVAC when doors/windows are left open (unrelated to monitoring)
- `alwineinger/hubitat/Honeywell/` — security zone drivers, not thermostats
- `alwineinger/device-type.myecobee` — Ecobee driver, not Honeywell T6

The standard Hubitat driver for the T6 Pro exposes: temperature, setpoints, operating state, humidity, fan mode, battery. It does **not** expose runtime counters.

---

## Repos involved

- `alwineinger/hal9000-v3` — HAL workspace (this doc lives here)
- `alwineinger/hubitat` — Hubitat drivers (security, aqualogic, pool)
- `alwineinger/Hubitat-alw` — Hubitat apps and custom drivers

---

## Notes

- Hubitat is the primary HA controller. Not all devices are exposed to HAL — Andy controls what gets exposed.
- Thermostat (device 1806) is currently the only exposed HVAC device. More may exist.
- Hubitat has thermostat integration (Nester/Ecobee/Honeywell or native Hubitat device) — currently not fully wired up to HAL.