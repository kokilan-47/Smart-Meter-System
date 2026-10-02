import React, { useCallback, useEffect, useState } from "react";
import { Line, Bar } from "react-chartjs-2";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  BarElement,
  PointElement,
  Tooltip,
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);
const API = window.ZENPLUG_API_URL || "http://localhost:3000/api";
const NAV = [
  ["overview", "Overview"],
  ["meters", "Meters"],
  ["readings", "Readings"],
  ["faults", "Faults"],
  ["billing", "Billing"],
  ["customers", "Enrollments"],
  ["settings", "Settings"],
  ["audit", "Audit log"],
];
const n = (value, digits = 1) =>
  value == null || Number.isNaN(Number(value))
    ? "–"
    : Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const date = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "–");
const money = (value) =>
  `LKR ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escError = (error) => error?.message || "The request failed.";
// A meter counts as online if it has sent a reading in the last 2 minutes.
const isOnline = (meter) => Boolean(meter.lastReadingAt) && Date.now() - new Date(meter.lastReadingAt).getTime() < 120000;
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

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("zenplugAdminToken") || "");
  const [tab, setTab] = useState(() => location.hash.slice(2).split("/")[0] || "overview");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState({ meters: [], readings: [] });
  const [reload, setReload] = useState(0);
  const call = useCallback(
    async (path, options = {}) => {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem("zenplugAdminToken");
          setToken("");
        }
        throw new Error(body.error || `${response.status} ${response.statusText}`);
      }
      return body;
    },
    [token],
  );
  useEffect(() => {
    const change = () => {
      setTab(location.hash.slice(2).split("/")[0] || "overview");
      setMessage(""); // don't carry "Saved successfully" over to another page
      setError("");
    };
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => setReload((x) => x + 1), 8000);
    return () => clearInterval(timer);
  }, [token]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([call("/auth/me"), call("/meter"), call("/readings?limit=500")])
      .then(([user, meters, readings]) => {
        if (user.role !== "admin") throw new Error("This portal is for administrator accounts.");
        if (active) {
          setData({ meters, readings });
          setError("");
        }
      })
      .catch((e) => active && setError(escError(e)));
    return () => {
      active = false;
    };
  }, [token, reload, call]);
  const perform = async (action) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await action();
      setMessage("Saved successfully.");
      setReload((x) => x + 1);
    } catch (e) {
      setError(escError(e));
    } finally {
      setBusy(false);
    }
  };
  const logout = () => {
    localStorage.removeItem("zenplugAdminToken");
    setToken("");
  };
  if (!token)
    return (
      <Login
        onLogin={(value) => {
          localStorage.setItem("zenplugAdminToken", value);
          setToken(value);
        }}
      />
    );
  const props = { call, data, perform, busy, reload };
  return (
    <>
      <header className="top">
        <div className="brand">
          <i>⚡</i>Zenplug Admin
        </div>
        <nav className="tabs">
          {NAV.map(([id, label]) => (
            <a key={id} href={`#/${id}`} className={tab === id ? "on" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span className="muted small">Administrator</span>
          <button className="btn sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main id="view">
        {error && (
          <div className="banner">
            {error}
            {error.toLowerCase().includes("failed to fetch")
              ? " Check that your API URL is configured and the backend is online."
              : ""}
          </div>
        )}
        {message && <div className="notice">{message}</div>}
        {tab === "overview" && <Overview {...props} />}
        {tab === "meters" && <Meters {...props} />}
        {tab === "readings" && <Readings {...props} />}
        {tab === "faults" && <Faults {...props} />}
        {tab === "billing" && <Billing {...props} />}
        {tab === "customers" && <Enrollments {...props} />}
        {tab === "settings" && <Settings {...props} />}
        {tab === "audit" && <Audit {...props} />}
      </main>
    </>
  );
}

function Login({ onLogin }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || "Sign-in failed.");
      if (result.user?.role !== "admin") throw new Error("This portal is for administrator accounts.");
      onLogin(result.token);
    } catch (err) {
      setError(escError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>⚡ Zenplug Admin</h1>
        <p className="muted">Sign in with your administrator account.</p>
        {error && <div className="banner">{error}</div>}
        <Field label="Email">
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <button className="btn primary full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="small muted">Administrator accounts are created by the system owner.</p>
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
              <tr key={row.key ?? i}>
                {row.cells.map((cell, j) => (
                  <td key={j}>{cell}</td>
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
function MeterStatus({ meter }) {
  const online = isOnline(meter);
  return (
    <span className={`pill ${online ? "ok" : meter.lastReadingAt ? "bad" : "info"}`}>
      {online ? "Online" : meter.lastReadingAt ? "Offline" : "Awaiting reading"}
    </span>
  );
}
function Overview({ data }) {
  const { meters, readings } = data;
  const online = meters.filter(isOnline).length;
  const power = meters.reduce((s, m) => s + Number(m.current_power || 0), 0) / 1000;
  const energy = meters.reduce((s, m) => s + Number(m.energy_used || 0), 0);
  const sorted = readings
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-100);
  const labels = sorted.map((r) => new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  return (
    <>
      <div className="kpis">
        <Stat label="Total meters" value={meters.length} />
        <Stat label="Meters online" value={`${online} / ${meters.length}`} />
        <Stat label="Live demand" value={n(power, 2)} unit="kW" />
        <Stat label="Energy reading" value={n(energy, 2)} unit="kWh" />
      </div>
      <div className="grid g2">
        <section className="card">
          <h3>Network voltage history</h3>
          <div className="chart">
            <Line
              data={{
                labels,
                datasets: [
                  ["L1", "voltage_l1", "#e5484d"],
                  ["L2", "voltage_l2", "#e8a10c"],
                  ["L3", "voltage_l3", "#3b82f6"],
                ].map(([label, key, color]) => ({
                  label,
                  data: sorted.map((r) => r[key]),
                  borderColor: color,
                  pointRadius: 0,
                  tension: 0.25,
                })),
              }}
              options={chartOptions}
            />
          </div>
        </section>
        <section>
          <div className="row between">
            <h3>Current meters</h3>
            <a href="#/meters">All meters</a>
          </div>
          <Table
            columns={["Meter", "Status", "Power", "Energy", "Updated"]}
            rows={meters.slice(0, 8).map((m) => ({
              cells: [
                <a className="mono" href={`#/meters/${encodeURIComponent(m.meter_id)}`}>
                  {m.meter_id}
                </a>,
                <MeterStatus meter={m} />,
                `${n(Number(m.current_power || 0) / 1000, 2)} kW`,
                `${n(m.energy_used, 2)} kWh`,
                date(m.lastReadingAt),
              ],
            }))}
          />
        </section>
      </div>
    </>
  );
}
function Meters({ call, data, perform, busy }) {
  const [show, setShow] = useState(false);
  const [id, setId] = useState("");
  const detailId = location.hash.split("/")[2];
  if (detailId) {
    const meter = data.meters.find((m) => m.meter_id === decodeURIComponent(detailId));
    const rows = data.readings.filter((r) => r.meter_id === decodeURIComponent(detailId));
    return (
      <>
        <div className="row between">
          <h2>Meter {decodeURIComponent(detailId)}</h2>
          <a className="btn" href="#/meters">
            Back
          </a>
        </div>
        {meter ? (
          <div className="kpis">
            <Stat label="L1 voltage" value={n(meter.voltage_l1)} unit="V" />
            <Stat label="L2 voltage" value={n(meter.voltage_l2)} unit="V" />
            <Stat label="L3 voltage" value={n(meter.voltage_l3)} unit="V" />
            <Stat label="Power" value={n(Number(meter.current_power || 0) / 1000, 2)} unit="kW" />
            <Stat label="Energy" value={n(meter.energy_used, 2)} unit="kWh" />
          </div>
        ) : (
          <div className="banner">Meter not found.</div>
        )}
        <Table
          columns={["Timestamp", "L1", "L2", "L3", "Power", "Energy"]}
          rows={rows.map((r) => ({
            cells: [
              date(r.timestamp),
              `${n(r.voltage_l1)} V`,
              `${n(r.voltage_l2)} V`,
              `${n(r.voltage_l3)} V`,
              `${n(Number(r.current_power || 0) / 1000, 2)} kW`,
              `${n(r.energy_used, 2)} kWh`,
            ],
          }))}
        />
      </>
    );
  }
  const register = (e) => {
    e.preventDefault();
    void perform(async () => {
      await call("/admin/meters", { method: "POST", body: JSON.stringify({ meter_id: id.trim() }) });
      setShow(false);
      setId("");
    });
  };
  return (
    <>
      <div className="row between">
        <h2>Meter Management</h2>
        <div className="row">
          <button className="btn" onClick={() => location.reload()}>
            Refresh
          </button>
          <button className="btn primary" onClick={() => setShow(true)}>
            Add meter
          </button>
        </div>
      </div>
      <Table
        columns={["Meter ID", "Status", "L1", "L2", "L3", "Power", "Energy", "Last update"]}
        rows={data.meters.map((m) => ({
          cells: [
            <a className="mono" href={`#/meters/${encodeURIComponent(m.meter_id)}`}>
              {m.meter_id}
            </a>,
            <MeterStatus meter={m} />,
            `${n(m.voltage_l1)} V`,
            `${n(m.voltage_l2)} V`,
            `${n(m.voltage_l3)} V`,
            `${n(Number(m.current_power || 0) / 1000, 2)} kW`,
            `${n(m.energy_used, 2)} kWh`,
            date(m.lastReadingAt),
          ],
        }))}
      />
      {show && (
        <div className="back">
          <form className="modal" onSubmit={register}>
            <h2>Register meter</h2>
            <p className="muted">
              Reserves a meter ID for customer enrollment. It stays offline until its device sends a real reading.
            </p>
            <Field label="Meter ID">
              <input autoFocus required value={id} onChange={(e) => setId(e.target.value)} />
            </Field>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setShow(false)}>
                Cancel
              </button>
              <button disabled={busy} className="btn primary">
                Register meter
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
function Readings({ data }) {
  const rows = data.readings.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return (
    <>
      <div className="row between">
        <h2>Historical Readings</h2>
        <span className="muted small">{rows.length} records loaded</span>
      </div>
      <div className="card">
        <div className="chart">
          <Line
            data={{
              labels: rows
                .slice()
                .reverse()
                .map((r) => new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
              datasets: [
                {
                  label: "Power (kW)",
                  data: rows
                    .slice()
                    .reverse()
                    .map((r) => Number(r.current_power || 0) / 1000),
                  borderColor: "#4f8cff",
                  backgroundColor: "#4f8cff33",
                  fill: true,
                  pointRadius: 0,
                },
              ],
            }}
            options={chartOptions}
          />
        </div>
      </div>
      <Table
        columns={["Timestamp", "Meter", "L1", "L2", "L3", "Power", "Energy"]}
        rows={rows.map((r) => ({
          cells: [
            date(r.timestamp),
            <span className="mono">{r.meter_id}</span>,
            `${n(r.voltage_l1)} V`,
            `${n(r.voltage_l2)} V`,
            `${n(r.voltage_l3)} V`,
            `${n(Number(r.current_power || 0) / 1000, 2)} kW`,
            `${n(r.energy_used, 2)} kWh`,
          ],
        }))}
      />
    </>
  );
}
function Faults({ call, perform, reload }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("active");
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    call(filter === "all" ? "/faults" : `/faults?status=${filter}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [call, filter, reload]);
  const resolve = (ids) =>
    perform(async () => {
      if (ids.length === 1)
        await call(`/faults/${ids[0]}/resolve`, {
          method: "PATCH",
          body: JSON.stringify({ note: "Resolved from admin dashboard" }),
        });
      else
        await call("/faults/bulk-resolve", {
          method: "POST",
          body: JSON.stringify({ ids, note: "Bulk resolved from admin dashboard" }),
        });
      setPicked([]);
    });
  return (
    <>
      <div className="row between">
        <h2>Fault Management</h2>
        <div className="row">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
          {picked.length > 0 && (
            <button className="btn" onClick={() => resolve(picked)}>
              Resolve selected ({picked.length})
            </button>
          )}
        </div>
      </div>
      <Table
        columns={["", "Meter", "Type", "Phase", "Value", "Limit", "Last seen", "Status", "Action"]}
        rows={rows.map((f) => ({
          key: f._id,
          cells: [
            f.status === "active" ? (
              <input
                type="checkbox"
                checked={picked.includes(f._id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, f._id] : picked.filter((x) => x !== f._id))}
              />
            ) : (
              ""
            ),
            f.meter_id,
            f.type,
            f.phase,
            f.value,
            f.limit,
            date(f.lastSeen),
            f.status,
            f.status === "active" ? (
              <button className="btn sm" onClick={() => resolve([f._id])}>
                Resolve
              </button>
            ) : (
              "–"
            ),
          ],
        }))}
      />
    </>
  );
}
function Enrollments({ call, perform, reload }) {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState([]);
  const [meters, setMeters] = useState([]);
  const [selection, setSelection] = useState({});
  useEffect(() => {
    call(status === "all" ? "/admin/customers" : `/admin/customers?status=${status}`)
      .then(setRows)
      .catch(() => setRows([]));
    call("/meter")
      .then(setMeters)
      .catch(() => {});
  }, [call, status, reload]);
  const review = (id, action, meter_id) =>
    perform(() => call(`/admin/customers/${id}/review`, { method: "PATCH", body: JSON.stringify({ status: action, meter_id }) }));
  const remove = (c) => {
    if (
      window.confirm(`Remove ${c.fullName} (${c.email})? They will no longer be able to sign in. Their meter and bills are kept.`)
    )
      void perform(() => call(`/admin/customers/${c.id}`, { method: "DELETE" }));
  };
  return (
    <>
      <div className="row between">
        <div>
          <h2>Customer Enrollments</h2>
          <span className="muted small">Review requests and link approved accounts to a meter.</span>
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Pending</option>
          <option value="active">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>
      <Table
        columns={["Name", "Email", "Meter", "Status", "Requested", "Review"]}
        rows={rows.map((c) => ({
          key: c.id,
          cells: [
            c.fullName,
            c.email,
            c.meter_id,
            c.status,
            date(c.createdAt),
            c.status === "pending" ? (
              <div className="row">
                <select
                  value={selection[c.id] ?? c.meter_id ?? ""}
                  onChange={(e) => setSelection({ ...selection, [c.id]: e.target.value })}
                >
                  {meters.map((m) => (
                    <option key={m.meter_id} value={m.meter_id}>
                      {m.meter_id}
                    </option>
                  ))}
                </select>
                <button className="btn primary sm" onClick={() => review(c.id, "active", selection[c.id] ?? c.meter_id)}>
                  Approve
                </button>
                <button className="btn danger sm" onClick={() => review(c.id, "rejected")}>
                  Reject
                </button>
              </div>
            ) : (
              <button className="btn danger sm" onClick={() => remove(c)}>
                Remove
              </button>
            ),
          ],
        }))}
      />
    </>
  );
}
function Billing({ call, perform, reload, busy }) {
  const [bills, setBills] = useState([]);
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  useEffect(() => {
    call("/bills")
      .then(setBills)
      .catch(() => setBills([]));
  }, [call, reload]);
  const generate = () => {
    const [year, monthNumber] = month.split("-").map(Number);
    void perform(() => call("/bills/generate", { method: "POST", body: JSON.stringify({ year, month: monthNumber }) }));
  };
  const change = (id, status) =>
    perform(() => call(`/bills/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }));
  const outstanding = bills
    .filter((b) => b.status !== "paid" && b.status !== "cancelled")
    .reduce((sum, b) => sum + Number(b.total || 0), 0);
  return (
    <>
      <div className="row between">
        <h2>Billing</h2>
        <div className="row">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          <button className="btn primary" disabled={busy} onClick={generate}>
            Generate bills
          </button>
        </div>
      </div>
      <div className="kpis">
        <Stat label="Bills" value={bills.length} />
        <Stat label="Outstanding" value={money(outstanding)} />
      </div>
      <Table
        columns={["Period", "Meter", "Units", "Total", "Due date", "Status", "Update"]}
        rows={bills.map((b) => ({
          key: b._id,
          cells: [
            b.period,
            b.meter_id,
            `${n(b.units, 2)} kWh`,
            money(b.total),
            date(b.dueDate),
            b.status,
            <select value={b.status} onChange={(e) => change(b._id, e.target.value)}>
              {["issued", "paid", "overdue", "cancelled"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>,
          ],
        }))}
      />
    </>
  );
}
function Settings({ call, perform, reload, busy }) {
  const [settings, setSettings] = useState(null);
  const [tariffs, setTariffs] = useState([]);
  const [form, setForm] = useState({});
  const [tier, setTier] = useState({ name: "", from: 0, to: "", rate: 0 });
  const [editing, setEditing] = useState(null);
  useEffect(() => {
    Promise.all([call("/settings"), call("/tariffs")])
      .then(([s, t]) => {
        setSettings(s);
        setForm(s);
        setTariffs(t);
      })
      .catch(() => {});
  }, [call, reload]);
  const save = (e) => {
    e.preventDefault();
    void perform(async () => {
      await call("/settings", {
        method: "PUT",
        body: JSON.stringify(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)]))),
      });
    });
  };
  const saveTier = (e, item = tier) => {
    e.preventDefault();
    void perform(async () => {
      const body = {
        ...item,
        from: Number(item.from),
        to: item.to === "" ? null : Number(item.to),
        rate: Number(item.rate),
        active: item.active !== false,
      };
      await call(item._id ? `/tariffs/${item._id}` : "/tariffs", {
        method: item._id ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      setEditing(null);
      setTier({ name: "", from: 0, to: "", rate: 0 });
    });
  };
  const deleteTier = (id) => perform(() => call(`/tariffs/${id}`, { method: "DELETE" }));
  return (
    <>
      <h2>Settings</h2>
      {settings && (
        <form className="card" onSubmit={save}>
          <h3>Monitoring and billing thresholds</h3>
          <div className="form-grid">
            {Object.entries(form).map(([key, value]) => (
              <Field key={key} label={key.replace(/([A-Z])/g, " $1")}>
                <input type="number" value={value} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              </Field>
            ))}
          </div>
          <button disabled={busy} className="btn primary">
            Save settings
          </button>
        </form>
      )}
      <h3 className="section-title">Tariff tiers</h3>
      <form className="card row" onSubmit={(e) => saveTier(e)}>
        <input required placeholder="Tier name" value={tier.name} onChange={(e) => setTier({ ...tier, name: e.target.value })} />
        <input
          type="number"
          placeholder="From kWh"
          value={tier.from}
          onChange={(e) => setTier({ ...tier, from: e.target.value })}
        />
        <input
          type="number"
          placeholder="To kWh (blank = unlimited)"
          value={tier.to}
          onChange={(e) => setTier({ ...tier, to: e.target.value })}
        />
        <input
          required
          type="number"
          placeholder="Rate"
          value={tier.rate}
          onChange={(e) => setTier({ ...tier, rate: e.target.value })}
        />
        <button className="btn primary" disabled={busy}>
          Add tier
        </button>
      </form>
      <Table
        columns={["Tier", "From", "To", "Rate", "Active", ""]}
        rows={tariffs.map((t) => ({
          key: t._id,
          cells: [
            t.name,
            t.from,
            t.to ?? "Unlimited",
            money(t.rate),
            t.active ? "Yes" : "No",
            <div className="row">
              <button className="btn sm" onClick={() => setEditing({ ...t, to: t.to ?? "" })}>
                Edit
              </button>
              <button className="btn danger sm" onClick={() => deleteTier(t._id)}>
                Delete
              </button>
            </div>,
          ],
        }))}
      />
      {editing && (
        <div className="back">
          <form className="modal" onSubmit={(e) => saveTier(e, editing)}>
            <h2>Edit tariff</h2>
            <Field label="Name">
              <input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="form-grid">
              <Field label="From kWh">
                <input type="number" value={editing.from} onChange={(e) => setEditing({ ...editing, from: e.target.value })} />
              </Field>
              <Field label="To kWh (blank = unlimited)">
                <input type="number" value={editing.to} onChange={(e) => setEditing({ ...editing, to: e.target.value })} />
              </Field>
              <Field label="Rate">
                <input type="number" value={editing.rate} onChange={(e) => setEditing({ ...editing, rate: e.target.value })} />
              </Field>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
              />{" "}
              Active
            </label>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy}>
                Save tariff
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
function Audit({ call, reload }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    call("/audit?limit=200")
      .then(setRows)
      .catch(() => setRows([]));
  }, [call, reload]);
  return (
    <>
      <h2>Audit Log</h2>
      <Table
        columns={["Time", "Actor", "Action", "Entity", "Entity ID", "Details"]}
        rows={rows.map((r) => ({
          key: r._id,
          cells: [date(r.createdAt), r.actor, r.action, r.entity, r.entityId, <code>{JSON.stringify(r.details || {})}</code>],
        }))}
      />
    </>
  );
}

export default App;
