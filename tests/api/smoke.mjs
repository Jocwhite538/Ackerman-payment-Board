// End-to-end checks against the REAL ASP.NET Core server (not the stand-in).
// GitHub Actions starts the app with Development settings (empty database,
// first-run setup on, demo patients on) and TZ=America/New_York, then runs this.
//
//   APP_URL=http://127.0.0.1:5087 node tests/api/smoke.mjs
//
// Needs Node 20+. No packages.

const BASE = process.env.APP_URL || "http://127.0.0.1:5087";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? `  [${detail}]` : ""}`);
};

function makeClient() {
  const jar = new Map();
  return async function http(method, path, { body, form, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload;
    if (form) { h["Content-Type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      const expires = attrs.map((a) => a.trim()).find((a) => /^expires=/i.test(a));
      if (!value || (expires && new Date(expires.slice(8)) < new Date())) jar.delete(name); else jar.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML */ }
    return { status: res.status, location: res.headers.get("location") || "", cacheControl: res.headers.get("cache-control") || "", text, json };
  };
}

const formToken = (html) =>
  /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html)?.[1] ||
  /value="([^"]+)"[^>]*name="__RequestVerificationToken"/.exec(html)?.[1] || "";

async function signIn(http, username, password) {
  const page = await http("GET", "/account/login");
  return http("POST", "/account/login", { form: { Username: username, Password: password, ReturnUrl: "", __RequestVerificationToken: formToken(page.text) } });
}

const today = new Date().toLocaleDateString("en-CA");

async function main() {
  // Wait for the server.
  const started = Date.now();
  for (;;) {
    try { const r = await fetch(`${BASE}/`, { redirect: "manual" }); if (r.status < 500) break; } catch { /* not up yet */ }
    if (Date.now() - started > 120000) throw new Error("The app did not start within 2 minutes.");
    await new Promise((r) => setTimeout(r, 1000));
  }

  const admin = makeClient();
  const root = await admin("GET", "/");
  check("empty database sends / to first-run setup", root.status === 302 && /\/setup$/i.test(root.location), root.location);

  const setupPage = await admin("GET", "/setup");
  const setup = await admin("POST", "/setup", { form: { Username: "ci-admin", Password: "ci-pass-123", ConfirmPassword: "ci-pass-123", __RequestVerificationToken: formToken(setupPage.text) } });
  check("first Super User created", setup.status === 302 && /login/i.test(setup.location), `${setup.status} ${setup.location}`);

  const anonymous = await makeClient()("GET", "/api/patients");
  check("signed-out API call gets 401, not the login page", anonymous.status === 401, String(anonymous.status));

  const login = await signIn(admin, "ci-admin", "ci-pass-123");
  check("Super User signs in", login.status === 302 && /\/app$/i.test(login.location), `${login.status} ${login.location}`);

  const board = await admin("GET", "/app");
  check("board page loads and is not cached", board.status === 200 && /no-store/i.test(board.cacheControl) && board.text.includes("patient-merge.js?v=3.3.0"), board.cacheControl);

  const csrf = (await admin("GET", "/api/antiforgery")).json?.token || "";
  const api = (method, path, body) => admin(method, path, { body, headers: { "X-CSRF-TOKEN": csrf, Accept: "application/json" } });

  const list = await api("GET", "/api/patients");
  const patients = list.json?.patients || [];
  check("24 demo patients were loaded", patients.length === 24 && patients.every((p) => p.id.startsWith("demo-") && p.data.mrn.startsWith("DEMO-")), `${patients.length} patients`);
  check("list response has the expected shape", typeof list.json?.seq === "number" && patients.every((p) => p.revision === 1 && p.data && p.updatedAtUtc), `seq ${list.json?.seq}`);
  const seqAtStart = list.json?.seq ?? 0;

  const p1 = patients.find((p) => p.id === "demo-001");
  const edited = structuredClone(p1.data); edited.statusNote = "CI note";
  const save = await api("PUT", "/api/patients/demo-001", { revision: p1.revision, patient: edited });
  check("save with the current revision succeeds", save.status === 200 && save.json?.revision === p1.revision + 1 && save.json?.patient?.statusNote === "CI note", `${save.status} rev ${save.json?.revision}`);

  const staleCopy = structuredClone(p1.data); staleCopy.statusNote = "stale";
  const stale = await api("PUT", "/api/patients/demo-001", { revision: p1.revision, patient: staleCopy });
  check("stale save gets 409 with the newer patient", stale.status === 409 && stale.json?.revision === p1.revision + 1 && stale.json?.patient?.statusNote === "CI note", `${stale.status}`);

  const current = save.json.patient;
  const originalPayments = current.payments.length;
  const tampered = structuredClone(current);
  const originalAmount = tampered.payments[0].amount;
  tampered.payments[0].amount = 1;
  tampered.payments.splice(1, 1);
  tampered.payments.push({ id: "ci-pay-1", type: "Payment", amount: 10, date: today, method: "Cash", username: "someone-else", recordedBy: "forged" });
  const tamper = await api("PUT", "/api/patients/demo-001", { revision: save.json.revision, patient: tampered });
  const stored = tamper.json?.patient?.payments || [];
  const added = stored.find((x) => x.id === "ci-pay-1");
  check("edited payment amount is refused", tamper.status === 200 && stored[0]?.amount === originalAmount, `${stored[0]?.amount} vs ${originalAmount}`);
  check("deleted payment is put back", stored.length === originalPayments + 1, `${originalPayments} -> ${stored.length}`);
  check("new payment is stamped by the server", added?.username === "ci-admin" && added?.recordedBy === "ci-admin" && !!added?.recordedAtUtc, JSON.stringify(added));
  check("refused ledger changes are reported", (tamper.json?.warnings || []).length === 2, (tamper.json?.warnings || []).join(" | "));

  const dup = await api("PUT", "/api/patients/ci-new-1", { revision: 0, patient: { id: "ci-new-1", name: "CI Duplicate", mrn: "demo-1002", payments: [] } });
  check("duplicate MRN is refused", dup.status === 400 && /MRN/.test(dup.json?.message || ""), dup.json?.message);

  const spaced = await api("PUT", "/api/patients/demo-001%20", { revision: 0, patient: { ...current, id: "demo-001 " } });
  check("id with a trailing space is refused", spaced.status === 400, String(spaced.status));

  const cased = await api("PUT", "/api/patients/DEMO-001", { revision: 0, patient: { ...current, id: "DEMO-001" } });
  check("id differing only by case is refused", cased.status === 400, String(cased.status));
  const afterCase = (await api("GET", "/api/patients")).json?.patients.find((p) => p.id === "demo-001");
  check("original patient untouched by those attempts", afterCase?.revision === tamper.json?.revision && afterCase?.data.payments.length === originalPayments + 1);

  const created = await api("PUT", "/api/patients/ci-new-2", { revision: 0, patient: { id: "ci-new-2", name: "CI Patient", mrn: "CI-0002", payments: [{ id: "ci-new-2-pay", type: "Payment", amount: 25, date: today }] } });
  check("new patient is created", created.status === 200 && created.json?.revision === 1 && created.json?.patient?.payments?.[0]?.recordedBy === "ci-admin", String(created.status));

  const changes = await api("GET", `/api/patients/changes?since=${seqAtStart}`);
  const changedIds = (changes.json?.patients || []).map((p) => p.id);
  check("changes feed returns only what changed", changedIds.includes("demo-001") && changedIds.includes("ci-new-2") && changedIds.length === 2, changedIds.join(", "));

  const old = await api("PUT", "/api/state", { revision: 1, patients: [] });
  check("old whole-board save is refused", old.status === 409, String(old.status));
  check("board still has every patient", (await api("GET", "/api/patients")).json?.patients.length === 25);

  const history = await api("GET", "/api/patients/demo-001/history");
  check("Super User can list saved versions", history.status === 200 && (history.json || []).length === 3, `${(history.json || []).length} versions`);
  const first = await api("GET", "/api/patients/demo-001/history/1");
  check("original version can be opened", first.status === 200 && first.json?.patient?.statusNote === "" && first.json?.patient?.payments?.length === originalPayments, String(first.status));

  const adminPage = await admin("GET", "/admin");
  for (const entry of ["Board migrated to per-patient records", "Demo patients loaded", "Ledger change refused", "Payment recorded $10.00"])
    check(`audit history shows "${entry}"`, adminPage.text.includes(entry));

  // Failed-login lockout (the server runs in America/New_York for this test).
  const createPage = await admin("GET", "/admin/create");
  const createUser = await admin("POST", "/admin/create", { form: { Username: "ci-lock", TemporaryPassword: "lockpass1", Role: "StandardUser", __RequestVerificationToken: formToken(createPage.text) } });
  check("Standard User created", createUser.status === 302, String(createUser.status));
  const visitor = makeClient();
  for (let i = 0; i < 5; i++) await signIn(visitor, "ci-lock", "wrong-password");
  const locked = await signIn(visitor, "ci-lock", "lockpass1");
  check("account is locked after 5 wrong passwords", locked.status === 200 && locked.text.includes("temporarily locked"), `${locked.status} ${locked.location}`);

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
