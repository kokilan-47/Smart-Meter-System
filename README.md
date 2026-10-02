# ⚡ Zenplug – smart three-phase meter portal

A full-stack web application for monitoring three-phase electricity meters. A meter sends its voltage,
power and energy readings to a Node.js/MongoDB backend. **Customers** sign up, get approved by the utility,
and then see their own live usage, bills and faults. **Administrators** manage meters and customers, handle
enrollments, resolve faults, issue bills and edit tariffs.

> **Student project.** This is a learning/demo project, not production software. Please read
> [How this project was built](#how-this-project-was-built-ai-assistance) and [Known limitations](#known-limitations)
> before relying on it.

## Features

**Customer portal**
- Register with a meter ID, then wait for administrator approval (pending accounts see nothing)
- Dashboard: current power, meter reading, usage this month, voltage per phase
- Usage charts for 1 hour / 24 hours / 7 days / 30 days and daily consumption
- Estimated bill for the current month and the history of issued bills
- Fault and alert history for their meter

**Administrator portal**
- Overview of all meters (online/offline, live demand, voltage history)
- Register meters, view every meter's readings
- **Enrollments:** review customer requests, link each one to a meter, approve / reject / remove
- Faults: automatic detection (over/under-voltage, phase failure, phase imbalance, meter offline), resolve one or many
- Billing: generate monthly bills from the meter's energy counter, update bill status (issued / paid / overdue / cancelled)
- Settings: fault thresholds and tariff tiers; audit log of administrator actions

**Backend**
- REST API with JWT sign-in, bcrypt-hashed passwords, role checks on every route, rate limiting on sign-in
- Meter ingestion endpoint for the ESP32 / meter hardware (see [docs/API.md](docs/API.md))
- Background check that flags silent meters and marks overdue bills

## How it works

```
meter hardware --POST /api/meter--> Express API <--> MongoDB
                                        ^
              admin portal (React) ----+---- customer portal (React)
```

## Tech stack

Node.js · Express 5 · MongoDB + Mongoose · JSON Web Tokens · bcryptjs · React 19 · Vite · Chart.js

## Project structure

```
backend/     Express API (server.js), Mongoose models, create-admin script, tests
admin/       Administrator portal (React + Vite)
customer/    Customer portal (React + Vite)
docs/API.md  The API, including the exact data the meter hardware must send
render.yaml  Optional Render deployment config for the API
```

## Run it locally

You need **Node.js 18+** and **MongoDB** running on your computer.

**1. Backend** (PowerShell; use `export` instead of `$env:` on Mac/Linux)

```bash
cd backend
npm install
$env:JWT_SECRET = "type-a-long-random-text-here"
npm run create-admin -- admin@example.com "a-password-of-12-or-more-characters"
npm start
```

The API runs on http://localhost:3000. By default it uses the database `smart_electric_meter` on local MongoDB;
set `MONGODB_URI` to use another (see [backend/.env.example](backend/.env.example)).

**2. Portals** (two more terminals)

```bash
cd admin
npm install
npm run dev
```

```bash
cd customer
npm install
npm run dev -- --port 5174
```

Open the admin portal at http://localhost:5173 and the customer portal at http://localhost:5174.
If the API is not on `localhost:3000`, change `public/config.js` in each portal.

**3. Try the whole flow**

1. Sign in to the admin portal and add a meter (Meters → Add meter), or let a meter report by itself:
   ```bash
   Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/meter -ContentType "application/json" -Body '{"meter_id":"MTR001","voltage_l1":230.4,"voltage_l2":231.1,"voltage_l3":229.8,"current_power":1450,"energy_used":1080.5}'
   ```
2. In the customer portal choose **Create account** and register with meter ID `MTR001`. The account is *pending*.
3. In the admin portal open **Enrollments** and approve it.
4. Sign in to the customer portal – you now see that meter's data.

## Tests

```bash
cd backend
npm test
```

16 integration tests run against a real MongoDB in a temporary database (`zenplug_enroll_test`, created and
deleted by the tests; your own data is not touched). They cover sign-in and roles, the enrollment flow, meter
validation and attack attempts, fault rules, offline detection, billing, and account deletion.
GitHub Actions runs them, and builds both portals, on every push (`.github/workflows/ci.yml`).

## Deploying online (Render + MongoDB Atlas + Netlify)

1. **Database:** create a free MongoDB Atlas cluster and copy its connection string.
2. **API:** on Render create a Blueprint from this repository (it reads `render.yaml`). When asked, enter
   `MONGODB_URI`, `METER_INGEST_TOKEN` (a long random secret you also give to the meter hardware) and `CORS_ORIGINS`
   (the two portal addresses, comma-separated, no trailing slash). Render generates `JWT_SECRET`.
3. **Portals:** create two Netlify sites from the repository, one with base directory `admin` and one with `customer`
   (each has a `netlify.toml`). Put the API address (`https://YOUR-API.onrender.com/api`) in each portal's
   `public/config.js` and redeploy.
4. **First admin:** create it once against the hosted database (`npm run create-admin` with `MONGODB_URI` set to the
   Atlas string). Never commit passwords, connection strings or tokens.

## Security notes

- Passwords are hashed with bcrypt; sign-in tokens expire after 8 hours; failed sign-ins are rate limited.
- The server will not use a built-in secret: without `JWT_SECRET` it generates a random one per run, and production refuses to start without it.
- Every admin and customer route checks the signed-in account on each request. Customers can only reach their own meter.
- Meter payloads are validated field by field (types and ranges); query inputs are treated as plain text to prevent NoSQL injection.
- Secrets live in environment variables, never in the code. `.env` files are git-ignored.

## Known limitations

This is a student project; these are honest gaps, not hidden ones:

- **Tariff:** billing uses simple editable tiers plus a flat supply charge. The default rates are placeholders, **not** the
  official Sri Lankan (PUCSL) tariff structure.
- **No online payments.** Administrators change a bill's status manually.
- **No password reset or e-mail verification.** Administrators are created with the `create-admin` script only.
- **Meters share one ingestion token** (not one key per meter), and the hardware must send readings over HTTPS in production.
- **Meter counter resets** (e.g. a replaced meter) are not handled; bill units would be understated for that month.
- **Bills are generated by an administrator** (a button), not automatically at month end.
- The admin overview voltage chart mixes the latest readings of all meters. Lists are not paginated.
- Sign-in tokens are kept in the browser's `localStorage`. Not load-tested.
- No meter firmware is included in this repository.

## How this project was built (AI assistance)

**We want to be upfront: most of the complex code in this repository was written by AI assistants, not by us.**

- We (the Zenplug team) are students who know the **basics** of web development and databases. We came up with the idea
  (a customer and administrator portal for three-phase meters with live data, bills and fault alerts), decided what
  features it needed, directed the work, and ran and tested it.
- The first version of this enrollment system (Express API, MongoDB models, React portals) was generated with
  OpenAI's Codex / ChatGPT. The visual design came from an earlier prototype built with Anthropic's Claude.
- A later review and hardening pass was done with Anthropic's Claude Code: it fixed bugs and security problems it
  found (for example an approve-button bug, a hardcoded fallback secret and an injection hole in the meter endpoint),
  rewrote the chart endpoints, added the tests, the CI workflow and this documentation.
- Because of this, we are still learning how every part works internally. Questions about specific files are best
  answered by walking through the code together; please judge this project accordingly.

## License

[MIT](LICENSE)
