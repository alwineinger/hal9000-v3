# Hubitat MakerAPI Reference

## Base URL
```
http://10.40.1.227/apps/api/2321
```

## Authentication
- Token stored in: `~/.openclaw/secrets/hubitat-api-key.txt`
- Token format in file: `access_token=108c58a4-aeff-4301-9610-7dd56b40a035`
- **Important**: When using the `/hubvariables/` endpoint, use the raw token value **without** the `access_token=` prefix
- For device command endpoints, use `?access_token=108c58a4-aeff-4301-9610-7dd56b40a035` (with or without prefix both work)

## Device Endpoints

### List all devices
```
GET /devices?access_token={token}
```

### Device details
```
GET /devices/all?access_token={token}        # full details
GET /devices/{deviceId}?access_token={token}
GET /devices/{deviceId}/attribute/{attribute}?access_token={token}
GET /devices/{deviceId}/events?access_token={token}
GET /devices/{deviceId}/commands?access_token={token}
GET /devices/{deviceId}/capabilities?access_token={token}
```

### Send device command
```
GET /devices/{deviceId}/{command}/{secondaryValue}?access_token={token}
```

### Set device label
```
GET /devices/{deviceId}/setLabel?label={Label}&access_token={token}
```

## Hub Variable Endpoints

### List all hub variables
```
GET /hubvariables?access_token={token}
```

### Get single hub variable
```
GET /hubvariables/{variableName}?access_token={token}
```

### Set hub variable (GET, not POST/PUT)
```
GET /hubvariables/{variableName}/{value}?access_token={token}
```
Returns: `{"name":"hvac_cool_day","value":77,"type":"integer"}`

## Mode Endpoints
```
GET /modes?access_token={token}
GET /modes/{modeId}?access_token={token}
```

## HSM (Hubitat Safety Monitor)
```
GET /hsm?access_token={token}
GET /hsm/{status}?access_token={token}
```

## Room Endpoints
```
GET /rooms?access_token={token}
GET /room/select/{roomId}?access_token={token}
POST /room/insert?name={name}&deviceIds={deviceIds}&access_token={token}
POST /room/update/{roomId}?name={name}&deviceIds={deviceIds}&access_token={token}
GET /room/delete/{roomId}?access_token={token}
```

## HVAC Variables (current)
| Hub Variable | Device ID | Current Value |
|---|---|---|
| hvac_cool_away | 2189 | 80°F |
| hvac_cool_day | 2190 | 75°F |
| hvac_cool_night | 2191 | 73°F |
| hvac_heat_away | 2192 | 60°F |
| hvac_heat_day | 2193 | 72°F |
| hvac_heat_night | 2194 | 65°F |

## Known Issues / Notes
- Connector Variable devices (2189-2194) expose hub variables as attributes but require the `/hubvariables/` endpoint to write — not the device command API
- The `/hubvariables/` endpoint requires raw token (no `access_token=` prefix)
- Device commands use GET, not POST — Hubitat's Maker API follows REST semantics loosely