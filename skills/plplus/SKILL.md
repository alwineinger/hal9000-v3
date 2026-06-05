# PL-PLUS Web Interface Skill

## Overview
Hayward PL-PLUS controller web interface running at `http://10.40.1.61:8089`.
Python/Flask server (Werkzeug) — likely from Andy's `aqualogic` repo.

**Read-only exploration only unless Andy explicitly approves changes.**

## API

### GET /api/display
Returns current LCD display state.
```json
{
  "blink": [],
  "leds": {},
  "lines": ["Pool Temp  84°F", "Air Temp   79°F", "", ""],
  "updated_at": 1780628575.8261044
}
```

### POST /api/key/<key>
Send a keypress to the controller. Available keys:
- `plus` / `minus` — navigate values up/down
- `left` / `right` — navigate menus
- `menu` — go to parent/next top-level menu
- `pool_spa` — Pool/Spa toggle (shortcut: P)
- `filter` — Filter quick action

All keys return `{ "key": "...", "ok": true/false }`.

## Menu Tree (from home display)

### Top-level menus (cycle with MENU)
1. **Settings** → Spa Heater, Pool Heater, VSP Speed Settings, Super Chlorinate, Spa Chlorinator, Pool Chlorinator, Set Day/Time, Display Light, Beeper
2. **Timers** → Filter T1-T4 schedules, Filter T1-T4 Speed (VSP %), Spa timers, Lights
3. **Diagnostic** → Chlorinator status, Salt, Flow Switch, Cell/Air/Water temps, VSP Speed/Power, Software Revisions
4. **Configuration** → LOCKED (PIN required)

### Settings Menu (sample)
- Spa Heater1
- Pool Heater1
- VSP Speed Settings
- Super Chlorinate
- Spa Chlorinator
- Pool Chlorinator (30%)
- Set Day and Time
- Display Light
- Beeper

### Timers Menu (sample)
- Filter T1-all 08:00A to 10:00A
- Filter T1-Spd1 70%
- Filter T2-all 10:00A to 11:00A
- Filter T2-Spd2 95%
- Filter T3-Spd3 55%
- Filter T4-Spd4 40%
- Spa-all Off
- Lights-CountDn

### Diagnostic Screen (sample)
- Pool Temp 84°F
- Air Temp 79°F
- Pool Chlorinator 30%
- Salt Level 3100 PPM
- Heater1 Manual Off
- Filter Speed 55% Speed3

## Key Observations
- Current state (2026-06-04 ~11 PM ET): Pool mode, heater OFF, filter at 55% Speed3
- VSP (Variable Speed Pump) has 4 preset speeds (Spd1-Spd4) configurable per time block
- Pump speed can be controlled via the Timers menu (VSP Speed Settings)
- No API authentication visible — interface is on local network only

## Future Ops
- **Pump speed control**: Explore VSP Speed Settings menu to adjust pump speed programmatically via POST /api/key/plus|minus
- **Heater control**: Spa Heater1 / Pool Heater1 settings — same pattern
- **Remote monitoring**: Poll GET /api/display periodically to read pool temp, air temp, heater status, filter speed

## Code Locations
- Server likely in `~/Code/hayward/aqualogic/` or similar (Andy Wineinger's repo)
- Hubitat integration via RS485 in `hubitat/aqualogic` repos (not this web interface)
