import React, { useCallback, useEffect, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

// The API address comes from public/config.js so it can be changed without rebuilding.
const API = window.ZENPLUG_API_URL || "http://localhost:3000/api";
const NAV = [
  ["dashboard", "Dashboard"],
  ["usage", "Usage"],
  ["bills", "Bills"],
  ["faults", "Faults"],
  ["profile", "Profile"],
];
const PHASES = [
  ["L1", "voltage_l1", "#e5484d"],
  ["L2", "voltage_l2", "#e8a10c"],
  ["L3", "voltage_l3", "#3b82f6"],
];

const n = (value, digits = 1) =>
  value == null || !Number.isFinite(Number(value))
    ? "–"
    : Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = (value) =>
  `LKR ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "–");
const timeLabel = (value, range) =>
  new Date(value).toLocaleString(
    [],
    range === "7d" || range === "30d"
      ? { day: "numeric", month: "short", hour: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" },
  );
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { labels: { color: "#93a0b8" } } },
  scales: {
    x: { ticks: { color: "#93a0b8", maxTicksLimit: 10 }, grid: { color: "#263349" } },
    y: { ticks: { color: "#93a0b8" }, grid: { color: "#263349" } },
  },
};
const voltageChart = (rows, range) => ({
  labels: rows.map((r) => timeLabel(r.timestamp, range)),
  datasets: PHASES.map(([label, key, color]) => ({
    label,
    data: rows.map((r) => r[key]),
    borderColor: color,
    pointRadius: 0,
    tension: 0.25,
  })),
});

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("zenplugToken") || "");
  const [tab, setTab] = useState(() => location.hash.slice(2) || "dashboard");
  const [account, setAccount] = useState(null);
  const [meter, setMeter] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0); // goes up every few seconds; pages refetch when it changes

  const call = useCallback(
    async (path, options = {}) => {
      const response = await fetch(`${API}${path}`, {
        ...options,
        cache: "no-store",
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem("zenplugToken");
          setToken("");
        }
        throw new Error(body.error || `${response.status} ${response.statusText}`);
      }
      return body;
    },
    [token],
  );

  useEffect(() => {
    const change = () => setTab(location.hash.slice(2) || "dashboard");
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);

  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => setTick((x) => x + 1), 8000);
    return () => clearInterval(timer);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    call("/auth/me")
      .then((user) => {
        if (user.role !== "customer") throw new Error("This portal is for customer accounts.");
        if (alive) {
          setAccount(user);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    call("/customer/meter")
      .then((value) => alive && setMeter(value))
      .catch((e) => {
        if (!alive) return;
        setMeter(null);
        if (!e.message.includes("waiting for its first reading") && !e.message.includes("no readings yet")) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [token, tick, call]);

  const logout = () => {
    localStorage.removeItem("zenplugToken");
    setToken("");
    setAccount(null);
  };
  if (!token)
    return (
      <Auth
        onAuth={(value) => {
          localStorage.setItem("zenplugToken", value);
          setToken(value);
        }}
      />
    );

  const props = { account, meter, call, tick };
  return (
    <>
      <header className="top">
        <div className="brand">
          <i>⚡</i>Zenplug
        </div>
        <nav className="tabs">
          {NAV.map(([id, label]) => (
            <a key={id} className={tab === id ? "on" : ""} href={`#/${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span className="muted small">Customer Portal</span>
          <button className="btn sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main id="view">
        {error && <div className="banner">{error}</div>}
        {tab === "dashboard" && <Dashboard {...props} />}
        {tab === "usage" && <Usage {...props} />}
        {tab === "bills" && <Bills {...props} />}
        {tab === "faults" && <Faults {...props} />}
        {tab === "profile" && <Profile {...props} />}
      </main>
    </>
  );
}

function Auth({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const register = mode === "register";

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const response = await fetch(`${API}/auth/${register ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Request failed.");
      if (register) {
        setMode("login");
        setNotice("Registration submitted. Your utility administrator must approve your account before you can sign in.");
      } else {
        if (body.user?.role !== "customer") throw new Error("This portal is for customer accounts.");
        onAuth(body.token);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>⚡ Zenplug</h1>
        <p className="muted">{register ? "Request access to your meter account." : "Sign in to your meter account."}</p>
        {notice && <div className="banner warn">{notice}</div>}
        {error && <div className="banner">{error}</div>}
        {register && (
          <>
            <Field label="Full name">
              <input name="fullName" autoComplete="name" required minLength="2" />
            </Field>
            <Field label="Meter ID">
              <input name="meter_id" autoComplete="off" required />
            </Field>
          </>
        )}
        <Field label="Email">
          <input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password">
          <input
            name="password"
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            minLength={register ? 10 : undefined}
            required
          />
        </Field>
        <button className="btn primary full" disabled={busy}>
          {busy ? "Please wait…" : register ? "Submit registration" : "Sign in"}
        </button>
        <p className="small muted">
          {register ? "Already registered?" : "New customer?"}{" "}
          <button
            className="link-button"
            type="button"
            onClick={() => {
              setMode(register ? "login" : "register");
              setError("");
            }}
          >
            {register ? "Sign in" : "Create account"}
          </button>
        </p>
      </form>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}
function Stat({ label, value, unit }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">
        {value} {unit && <span className="small muted">{unit}</span>}
      </div>
    </div>
  );
}
function Table({ columns, rows, empty = "No records found." }) {
  return (
    <div className="card tw">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td className="empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Dashboard({ account, meter, call, tick }) {
  const [rows, setRows] = useState([]);
  const [estimate, setEstimate] = useState(null);
  useEffect(() => {
    call("/customer/readings?range=1h")
      .then(setRows)
      .catch(() => setRows([]));
    call("/customer/billing-estimate")
      .then(setEstimate)
      .catch(() => setEstimate(null));
  }, [call, tick]);
  const used = estimate?.estimate?.units;

  return (
    <>
      {!meter && <div className="banner warn">Your meter is registered and linked, but is waiting for its first reading.</div>}
      <div className="kpis">
        <Stat label="Current power" value={meter ? n(Number(meter.current_power || 0) / 1000, 2) : "–"} unit="kW" />
        <Stat label="Meter reading" value={meter ? n(meter.energy_used, 2) : "–"} unit="kWh" />
        <Stat label="Used this month" value={n(used, 2)} unit="kWh" />
        <Stat label="Meter ID" value={account?.meter_id || "–"} />
      </div>
      <div className="grid g2">
        <section className="card">
          <h3>Voltage per phase (last hour)</h3>
          <div className="chart">
            <Line data={voltageChart(rows, "1h")} options={chartOptions} />
          </div>
        </section>
        <section className="card">
          <h3>Meter status</h3>
          <div className="field">
            <label>Customer</label>
            <div>{account?.fullName}</div>
          </div>
          <div className="field">
            <label>Last reading</label>
            <div>{date(meter?.lastReadingAt)}</div>
          </div>
          <div className="field">
            <label>Estimated bill so far</label>
            <div>{estimate?.estimate ? money(estimate.estimate.total) : "–"}</div>
          </div>
          <a href="#/usage">View usage</a>
        </section>
      </div>
    </>
  );
}

function Usage({ call, tick }) {
  const [range, setRange] = useState("24h");
  const [rows, setRows] = useState([]);
  const [daily, setDaily] = useState([]);
  useEffect(() => {
    call(`/customer/readings?range=${range}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [call, range, tick]);
  useEffect(() => {
    call("/customer/daily?days=30")
      .then(setDaily)
      .catch(() => setDaily([]));
  }, [call, tick]);

  return (
    <>
      <div className="row between">
        <h2>Usage</h2>
        <div className="seg">
          {["1h", "24h", "7d", "30d"].map((v) => (
            <button key={v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="grid g2">
        <section className="card">
          <h3>Voltage per phase</h3>
          <div className="chart">
            <Line data={voltageChart(rows, range)} options={chartOptions} />
          </div>
        </section>
        <section className="card">
          <h3>Power</h3>
          <div className="chart">
            <Line
              data={{
                labels: rows.map((r) => timeLabel(r.timestamp, range)),
                datasets: [
                  {
                    label: "kW",
                    data: rows.map((r) => Number(r.current_power || 0) / 1000),
                    borderColor: "#4f8cff",
                    pointRadius: 0,
                  },
                ],
              }}
              options={chartOptions}
            />
          </div>
        </section>
        <section className="card">
          <h3>Daily consumption (30 days)</h3>
          <div className="chart">
            <Bar
              data={{
                labels: daily.map((d) => d.date.slice(5)),
                datasets: [{ label: "kWh", data: daily.map((d) => d.kwh), backgroundColor: "#4f8cff" }],
              }}
              options={chartOptions}
            />
          </div>
        </section>
        <section className="card">
          <h3>Phase current</h3>
          <div className="empty">Current sensors are not part of the meter data, so phase current is not available.</div>
        </section>
      </div>
      <Table
        columns={["Time", "Voltage L1", "Voltage L2", "Voltage L3", "Power", "Meter reading"]}
        rows={rows
          .slice(-100)
          .reverse()
          .map((r) => [
            date(r.timestamp),
            `${n(r.voltage_l1)} V`,
            `${n(r.voltage_l2)} V`,
            `${n(r.voltage_l3)} V`,
            `${n(Number(r.current_power || 0) / 1000, 2)} kW`,
            `${n(r.energy_used, 2)} kWh`,
          ])}
        empty="No readings in this time range yet."
      />
    </>
  );
}

function Bills({ call, tick }) {
  const [estimate, setEstimate] = useState(null);
  const [bills, setBills] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([call("/customer/billing-estimate"), call("/customer/bills")])
      .then(([result, history]) => {
        setEstimate(result);
        setBills(history);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, [call, tick]);

  return (
    <>
      <h2>Bills</h2>
      {error && <div className="banner">{error}</div>}
      <section className="card">
        <h3>Current billing estimate</h3>
        {estimate?.estimate ? (
          <div className="kpis">
            <Stat label="Billing period" value={estimate.period} />
            <Stat label="Measured usage" value={n(estimate.estimate.units, 2)} unit="kWh" />
            <Stat label="Energy charge" value={money(estimate.estimate.energyCharge)} />
            <Stat label="Supply charge" value={money(estimate.estimate.supplyCharge)} />
            <Stat label="Tax" value={money(estimate.estimate.tax)} />
            <Stat label="Estimated total" value={money(estimate.estimate.total)} />
          </div>
        ) : (
          <div className="empty">No readings are available for this month yet, so an estimate cannot be calculated.</div>
        )}
        <p className="small muted">
          Estimate uses this meter’s readings and the utility’s current tariff settings. It is not an issued bill.
        </p>
      </section>
      <h3 className="section-title">Issued bills</h3>
      <Table
        columns={["Period", "Units", "Total", "Due date", "Status"]}
        rows={bills.map((b) => [
          b.period,
          `${n(b.units, 2)} kWh`,
          money(b.total),
          date(b.dueDate),
          <span className={`pill ${b.status === "paid" ? "ok" : b.status === "overdue" ? "bad" : "info"}`}>{b.status}</span>,
        ])}
        empty="No issued bills for this meter."
      />
    </>
  );
}

function Faults({ call, tick }) {
  const [faults, setFaults] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    call("/customer/faults")
      .then(setFaults)
      .catch((e) => setError(e.message));
  }, [call, tick]);

  return (
    <>
      <h2>Faults &amp; alerts</h2>
      {error && <div className="banner">{error}</div>}
      <Table
        columns={["Type", "Phase", "Value", "Limit", "First seen", "Status"]}
        rows={faults.map((f) => [
          f.type,
          f.phase,
          f.value,
          f.limit,
          date(f.firstSeen),
          <span className={`pill ${f.status === "active" ? "bad" : "ok"}`}>{f.status}</span>,
        ])}
        empty="No fault records are available for this meter."
      />
      <p className="small muted">These alerts are recorded by the backend for your linked meter.</p>
    </>
  );
}

function Profile({ account, meter }) {
  return (
    <>
      <h2>Meter profile</h2>
      <div className="grid g2">
        <section className="card">
          <h3>Connected meter</h3>
          <div className="field">
            <label>Customer</label>
            <div>{account?.fullName || "–"}</div>
          </div>
          <div className="field">
            <label>Email</label>
            <div>{account?.email || "–"}</div>
          </div>
          <div className="field">
            <label>Meter ID</label>
            <div className="mono">{account?.meter_id || "Not linked"}</div>
          </div>
          <div className="field">
            <label>Meter status</label>
            <div>{meter?.lastReadingAt ? "Reporting" : "Awaiting first reading"}</div>
          </div>
          <div className="field">
            <label>Data source</label>
            <div>Express API → MongoDB</div>
          </div>
        </section>
        <section className="card">
          <h3>Available measurements</h3>
          <div className="field">
            <label>Voltage</label>
            <div>Phase L1, L2, L3</div>
          </div>
          <div className="field">
            <label>Power</label>
            <div>Total current power</div>
          </div>
          <div className="field">
            <label>Energy</label>
            <div>Cumulative energy reading</div>
          </div>
        </section>
      </div>
    </>
  );
}

export default App;
