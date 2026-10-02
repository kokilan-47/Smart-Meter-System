# Zenplug API

Base URL when running locally: `http://localhost:3000`. All endpoints use JSON.

## 1. Meter → server (for the hardware team)

Send one reading per request:

```
POST /api/meter
Content-Type: application/json
Authorization: Bearer <METER_INGEST_TOKEN>
```

```json
{
  "meter_id": "MTR001",
  "voltage_l1": 230.4,
  "voltage_l2": 231.1,
  "voltage_l3": 229.8,
  "current_power": 1450,
  "energy_used": 1080.5
}
```

| Field | Meaning | Unit | Rules |
|---|---|---|---|
| `meter_id` | the meter's ID | text | 1-100 characters: letters, digits, `. _ : -` |
| `voltage_l1`, `voltage_l2`, `voltage_l3` | voltage of each phase | volts | number, 0 to 1000 |
| `current_power` | total power right now | **watts** | number, 0 to 10,000,000 |
| `energy_used` | the meter's **cumulative** energy counter (it only goes up) | **kWh** | number, 0 to 1,000,000,000 |

- Numbers must be real numbers (a numeric string such as `"230.5"` is also accepted). Extra fields are ignored.
- The server stamps each reading with its own arrival time.
- Bills are calculated from the difference of `energy_used` between the start and end of the month,
  so the counter must keep counting up and survive a meter restart.
- The first time an unknown `meter_id` reports, the meter is created automatically.
- Send a reading every 5-15 seconds. A meter that is silent for `offlineMinutes` (default 15) gets a "Meter offline" fault.

**The token.** In production the server requires `Authorization: Bearer <token>` and refuses everything else (`401`).
The token is the `METER_INGEST_TOKEN` environment variable on the server; ask the person who deploys it. On a local
development server where `METER_INGEST_TOKEN` is not set, the header is not needed.

| Reply | Meaning | What the meter should do |
|---|---|---|
| `201` | stored | nothing |
| `400` | a field is missing or out of range (the message says which) | fix the data; retrying the same data will not help |
| `401` | missing or wrong token | check the token |
| no answer / `5xx` | server or network trouble | try again later |

Test without hardware (PowerShell):

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/meter -ContentType "application/json" `
  -Body '{"meter_id":"MTR001","voltage_l1":230.4,"voltage_l2":231.1,"voltage_l3":229.8,"current_power":1450,"energy_used":1080.5}'
```

## 2. Sign-in (both portals)

```
POST /api/auth/register   { fullName, email, password (10+ chars), meter_id }   -> 201, account is "pending"
POST /api/auth/login      { email, password }                                   -> { token, user }
GET  /api/auth/me         (needs token)                                         -> the signed-in user
```

Every other call sends `Authorization: Bearer <token>`. Tokens last 8 hours. Errors look like `{ "error": "message" }`.
A customer account stays **pending** (cannot sign in or see any data) until an administrator approves it and links it to a meter.
Failed sign-ins are rate limited (10 per 15 minutes per address) and registrations (10 per hour).

## 3. Customer endpoints (role `customer`; always limited to the customer's own meter)

| Call | Returns |
|---|---|
| `GET /api/customer/meter` | the meter's latest values |
| `GET /api/customer/readings?range=1h\|24h\|7d\|30d` | readings averaged into time buckets, oldest first |
| `GET /api/customer/daily?days=30` | `[{ date, kwh }]` energy used per day |
| `GET /api/customer/billing-estimate` | this month's usage and estimated bill |
| `GET /api/customer/bills` | issued bills |
| `GET /api/customer/faults` | faults recorded for the meter |

## 4. Administrator endpoints (role `admin`)

| Call | Purpose |
|---|---|
| `GET /api/meter`, `GET /api/readings?meter_id=&limit=` | meters and recent readings |
| `POST /api/admin/meters` | `{ meter_id }` reserve a meter ID before it reports |
| `GET /api/admin/customers?status=pending\|active\|rejected` | enrollment requests |
| `PATCH /api/admin/customers/:id/review` | `{ status: "active" \| "rejected", meter_id }` approve or reject |
| `DELETE /api/admin/customers/:id` | remove a customer account (meter and bills are kept) |
| `GET /api/faults`, `PATCH /api/faults/:id/resolve`, `POST /api/faults/bulk-resolve` | fault list and resolving |
| `GET /api/bills`, `POST /api/bills/generate`, `PATCH /api/bills/:id/status` | billing |
| `GET/PUT /api/settings`, `GET/POST/PUT/DELETE /api/tariffs` | thresholds and tariff tiers |
| `GET /api/audit` | log of administrator actions |

`GET /api/health` needs no sign-in and reports whether the database is connected.

## 5. Data in MongoDB

| Collection | One document is |
|---|---|
| `users` | an administrator or customer login (bcrypt-hashed password, status, linked `meter_id`) |
| `meters` | a meter and its latest values |
| `meterreadings` | one report from a meter (deleted automatically after `READING_RETENTION_DAYS`, default 90) |
| `faults` | a fault with its first/last seen and status |
| `bills` | one bill per meter per month |
| `tariffs`, `settings` | billing tiers and thresholds |
| `auditlogs` | administrator actions |
