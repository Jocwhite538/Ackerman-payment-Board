// Test stand-in for the ASP.NET Core server. Mirrors the Version 3.3 C# behavior:
// LiteDbPatientStore (revisions, seq, history, MRN check, migration),
// PatientLedgerGuard (append-only ledger, stamps) and ApiController routes.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = process.argv[2];               // Source/Ackerman.PaymentBoard
const PORT = Number(process.argv[3] || 5099);
const LEGACY = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], "utf8")) : null;

const patients = new Map();   // id -> {id, json, revision, seq, name, mrn, updatedBy, updatedAtUtc}
const history = [];           // {patientId, revision, json, savedBy, savedAtUtc}
const audit = [];
let lastSeq = 0, migrated = false;
const tokens = new Map();     // user -> csrf token

function migrate(legacy) {
  if (migrated) return; migrated = true;
  let imported = 0, demo = 0;
  for (const item of legacy?.patients || []) {
    const id = String(item?.id || "").trim(), mrn = String(item?.mrn || "").trim();
    if (!id) continue;
    if (id.toLowerCase().startsWith("demo-") || mrn.toUpperCase().startsWith("DEMO-")) { demo++; continue; }
    if (patients.has(id)) continue;
    lastSeq++;
    const json = JSON.stringify(item);
    patients.set(id, { id, json, revision: 1, seq: lastSeq, name: item.name || "", mrn: mrn.toUpperCase(), updatedBy: legacy.updatedBy || "migration", updatedAtUtc: new Date().toISOString() });
    history.push({ patientId: id, revision: 1, json, savedBy: "Version 3.3 migration", savedAtUtc: new Date().toISOString() });
    imported++;
  }
  audit.push({ action: "Board migrated", details: `Imported ${imported}; removed ${demo} demo` });
}

// ---- PatientLedgerGuard port ----
const PAYMENT_FIELDS = ["type", "amount", "date", "responsibilityParty", "installmentId", "relatedTransactionId", "method", "officeSite", "appliesToPlan", "note", "username"];
const ADJ_FIELDS = ["type", "amount", "date", "note"];
const STAMPS = ["recordedBy", "recordedAtUtc"];
const text = (o, k) => (o && typeof o[k] === "string" ? o[k] : "");
function sameValue(stored, incoming) {
  if (stored === undefined || stored === null) return true;
  if (incoming === undefined || incoming === null) return false;
  if (typeof stored === "number" && typeof incoming === "number") return stored === incoming;
  return JSON.stringify(stored) === JSON.stringify(incoming);
}
function guard(storedJson, next, user, stamp, warnings) {
  const stored = storedJson ? JSON.parse(storedJson) : null;
  for (const [prop, label, locked, isPayment] of [["payments", "payment", PAYMENT_FIELDS, true], ["adjustments", "adjustment", ADJ_FIELDS, false]]) {
    const storedEntries = new Map();
    (Array.isArray(stored?.[prop]) ? stored[prop] : []).forEach((e) => { if (e && text(e, "id")) storedEntries.set(e.id, e); });
    let entries = next[prop];
    if (entries !== undefined && entries !== null && !Array.isArray(entries)) return `The ${label} list is not in the expected format.`;
    if (!entries) { if (!storedEntries.size) continue; entries = next[prop] = []; }
    const seen = new Set();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `A ${label} entry is not in the expected format.`;
      const id = text(entry, "id");
      if (!id.trim()) return `Every ${label} entry needs an id.`;
      if (seen.has(id)) return `The same ${label} entry appears twice.`;
      seen.add(id);
      const original = storedEntries.get(id);
      if (original) {
        const changed = locked.some((f) => !sameValue(original[f], entry[f]));
        const kept = JSON.parse(JSON.stringify(original));
        for (const [k, v] of Object.entries(entry)) if (!(k in kept) && !STAMPS.includes(k)) kept[k] = v;
        entries[i] = kept;
        if (changed) warnings.push(`A change to a recorded ${label} was not saved. Recorded ${label}s can't be edited; record a reversal or correction instead.`);
        continue;
      }
      if (typeof entry.amount !== "number" || !(entry.amount >= 0)) return `A new ${label} needs an amount of $0.00 or more.`;
      STAMPS.forEach((f) => delete entry[f]);
      if (isPayment) entry.username = user;
      entry.recordedBy = user; entry.recordedAtUtc = stamp;
    }
    const missing = [...storedEntries.keys()].filter((id) => !seen.has(id));
    missing.forEach((id) => entries.push(JSON.parse(JSON.stringify(storedEntries.get(id)))));
    if (missing.length) warnings.push(`${missing.length} recorded ${label}${missing.length === 1 ? " was" : "s were"} not removed. Recorded ${label}s can't be deleted; record a reversal or correction instead.`);
  }
  return null;
}

const validId = (id) => !!id && id.length <= 200 && id === id.trim() && ![...id].some((c) => /[\u0000-\u001f\u007f-\u009f]/.test(c));
function save(id, expectedRevision, user, incoming) {
  if (!validId(id)) return { status: "rejected", error: "Invalid patient id." };
  const current = patients.get(id);
  const currentRevision = current?.revision || 0;
  if (currentRevision !== expectedRevision) return { status: "conflict", current };
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return { status: "rejected", error: "Patient must be a JSON object." };
  const next = JSON.parse(JSON.stringify(incoming));
  if (text(next, "id") !== id) return { status: "rejected", error: "The patient id in the request does not match the address." };
  const warnings = [];
  const error = guard(current?.json, next, user, new Date().toISOString(), warnings);
  if (error) return { status: "rejected", error };
  const mrn = text(next, "mrn").trim().toUpperCase();
  if (mrn.length > 64) return { status: "rejected", error: "The MRN can be at most 64 characters." };
  if (mrn && mrn !== (current?.mrn || "") && [...patients.values()].some((p) => p.mrn === mrn && p.id !== id)) return { status: "rejected", error: "That MRN is already used by another patient on the board." };
  const record = { id, json: JSON.stringify(next), revision: currentRevision + 1, seq: lastSeq + 1, name: text(next, "name"), mrn, updatedBy: user, updatedAtUtc: new Date().toISOString() };
  patients.set(id, record);
  history.push({ patientId: id, revision: record.revision, json: record.json, savedBy: user, savedAtUtc: record.updatedAtUtc });
  lastSeq = record.seq;
  warnings.forEach((w) => audit.push({ action: "Ledger change refused", patientId: id, details: w }));
  audit.push({ action: current ? "Patient updated" : "Patient added", patientId: id, user });
  return { status: "saved", record, warnings };
}

const dto = (r) => ({ id: r.id, revision: r.revision, updatedBy: r.updatedBy, updatedAtUtc: r.updatedAtUtc, data: JSON.parse(r.json) });
const MIME = { ".js": "application/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8" };

function userOf(req) { const m = /(?:^|;\s*)u=([^;]+)/.exec(req.headers.cookie || ""); return m ? decodeURIComponent(m[1]) : null; }
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

migrate(LEGACY);

// Mirrors DemoPatientSeeder.cs: load demo patients into an empty board, moving
// every leading yyyy-MM-dd forward by (today - anchorDate) days.
if (process.env.DEMO_FILE && patients.size === 0) {
  const demo = JSON.parse(fs.readFileSync(process.env.DEMO_FILE, "utf8"));
  const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = process.env.DEMO_TODAY || local(new Date());
  const shift = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${demo.anchorDate}T12:00:00Z`)) / 86400000);
  const move = (v) => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      const d = new Date(`${v.slice(0, 10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + shift);
      return d.toISOString().slice(0, 10) + v.slice(10);
    }
    if (Array.isArray(v)) return v.map(move);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, move(x)]));
    return v;
  };
  for (const raw of demo.patients) {
    const p = shift ? move(raw) : raw;
    lastSeq++;
    patients.set(p.id, { id: p.id, json: JSON.stringify(p), revision: 1, seq: lastSeq, name: p.name, mrn: p.mrn.toUpperCase(), updatedBy: "Demo data", updatedAtUtc: new Date().toISOString() });
    history.push({ patientId: p.id, revision: 1, json: JSON.stringify(p), savedBy: "Demo data", savedAtUtc: new Date().toISOString() });
  }
  console.log(`loaded ${demo.patients.length} demo patients (dates moved ${shift} days)`);
}
const latencyMs = Number(process.env.MOCK_LATENCY_MS || 0);

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => setTimeout(() => handle(req, res, url, body), latencyMs));
}).listen(PORT, () => console.log(`mock listening on ${PORT}`));

function handle(req, res, url, body) {
  const p = url.pathname;
  if (p === "/__login") { const u = url.searchParams.get("u"); res.writeHead(302, { "Set-Cookie": `u=${encodeURIComponent(u)}; Path=/`, Location: "/app" }); return res.end(); }
  if (p === "/__state") return send(res, 200, { seq: lastSeq, patients: [...patients.values()].map(dto), history: history.map((h) => ({ patientId: h.patientId, revision: h.revision, savedBy: h.savedBy })), audit });
  if (p.startsWith("/assets/") || p.startsWith("/css/")) {
    const file = path.join(ROOT, "wwwroot", p);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  }
  const user = userOf(req);
  if (!user) return send(res, 401, { message: "sign in" });
  const pages = { "/app": "index.html", "/app/analytics": "analytics.html", "/app/completed": "completed.html" };
  if (pages[p]) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(fs.readFileSync(path.join(ROOT, "AppPages", pages[p]))); }
  if (p === "/api/antiforgery") { const t = crypto.randomUUID(); tokens.set(user, t); return send(res, 200, { token: t }); }
  if (p === "/api/session") return send(res, 200, { username: user, role: "StandardUser", isSuperUser: false });
  const writes = req.method !== "GET";
  if (writes && p.startsWith("/api/") && req.headers["x-csrf-token"] !== tokens.get(user)) return send(res, 400, { message: "antiforgery" });
  if (p === "/api/patients" && req.method === "GET") { const seq = lastSeq; return send(res, 200, { seq, patients: [...patients.values()].map(dto) }); }
  if (p === "/api/patients/changes") {
    const since = Number(url.searchParams.get("since") || 0), seq = lastSeq;
    return send(res, 200, { seq, patients: since >= seq ? [] : [...patients.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq).map(dto) });
  }
  let m = /^\/api\/patients\/([^/]+)$/.exec(p);
  if (m && req.method === "PUT") {
    const id = decodeURIComponent(m[1]);
    let request; try { request = JSON.parse(body); } catch (_) { return send(res, 400, { message: "The patient could not be read from the request." }); }
    const result = save(id, Number(request.revision || 0), user, request.patient);
    if (result.status === "conflict") return send(res, 409, { message: "This patient was changed on another workstation.", revision: result.current?.revision || 0, updatedBy: result.current?.updatedBy, updatedAtUtc: result.current?.updatedAtUtc, patient: result.current ? JSON.parse(result.current.json) : null });
    if (result.status === "rejected") return send(res, 400, { message: result.error });
    const r = result.record;
    return send(res, 200, { revision: r.revision, updatedBy: r.updatedBy, updatedAtUtc: r.updatedAtUtc, patient: JSON.parse(r.json), warnings: result.warnings });
  }
  if (p === "/api/state" && req.method === "PUT") return send(res, 409, { message: "The Payment Board was updated to Version 3.3. Refresh this page (Ctrl+F5) before making more changes.", updatedBy: "the Version 3.3 update" });
  if (/^\/api\/documents\/patient\//.test(p) && req.method === "GET") return send(res, 200, []);
  send(res, 404, { message: "not found" });
}
