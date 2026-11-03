// End-to-end: several users on the real Payment Board pages at the same time.
const { chromium } = require("playwright");
const assert = require("assert");
const BASE = process.argv[2] || "http://localhost:5099";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`); };
const server = async () => (await fetch(`${BASE}/__state`)).json();
const patient = (state, id) => state.patients.find((p) => p.id === id)?.data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, user) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.alerts = [];
  page.on("dialog", async (d) => { page.alerts.push(d.message()); await d.accept(); });
  page.on("pageerror", (e) => { page.errors = (page.errors || []).concat(String(e)); });
  await page.goto(`${BASE}/__login?u=${user}`);
  await page.waitForSelector("tr.patient-row");
  return page;
}

async function recordPayment(page, id, amount) {
  await page.click(`button[data-action="payments"][data-id="${id}"]`);
  await page.waitForSelector("#paymentsDialog[open]");
  await page.click('#paymentsDialog button[data-payments-action="record"]:not([disabled])');
  await page.waitForSelector("#paymentDialog[open]");
  await page.fill("#paymentAmount", String(amount));
  await page.evaluate(() => {
    for (const sel of ["#paymentOfficeSite", "#paymentMethod"]) {
      const s = document.querySelector(sel); const opt = [...s.options].find((o) => o.value); s.value = opt.value;
    }
  });
  await page.click('#paymentForm button[type="submit"]');
  await page.waitForSelector("#paymentDialog", { state: "hidden" });
  await page.click('#paymentsDialog [data-close="paymentsDialog"]');
  await page.waitForSelector("#paymentsDialog", { state: "hidden" });
}

async function setNote(page, id, note) {
  const input = page.locator(`input[data-status-note-id="${id}"]`);
  await input.fill(note);
  await input.press("Tab");
  await sleep(150);
}

const noteOnScreen = (page, id) => page.$eval(`input[data-status-note-id="${id}"]`, (el) => el.value);
const toasts = (page) => page.$$eval(".toast", (els) => els.map((e) => e.textContent));

(async () => {
  const browser = await chromium.launch();
  let state = await server();
  check("migration imported real patients and dropped demo ones", state.patients.length === 3 && !state.patients.some((p) => /^demo-/i.test(p.id) || /^DEMO-/i.test(p.data.mrn)), `${state.patients.length} patients`);

  const alice = await open(browser, "alice");
  const bob = await open(browser, "bob");
  const carol = await open(browser, "carol");

  // 1. Different patients at the same time.
  await Promise.all([recordPayment(alice, "patient-p1", 300), setNote(carol, "patient-p2", "Carol: call Tue")]);
  state = await server();
  check("different patients saved at the same time, no errors", patient(state, "patient-p1").payments.some((x) => x.amount === 300) && patient(state, "patient-p2").statusNote === "Carol: call Tue" && !alice.alerts.length && !carol.alerts.length);

  // 2. Same patient, different parts, from a stale screen (Bob has not seen Alice's payment yet).
  await setNote(bob, "patient-p1", "Bob: mailed statement");
  state = await server();
  const p1 = patient(state, "patient-p1");
  check("payment + status note on the same patient both kept", p1.payments.some((x) => x.amount === 300) && p1.statusNote === "Bob: mailed statement", `collected ${p1.collected}`);
  check("no alert or conflict notice for a clean merge", !bob.alerts.length && !(await toasts(bob)).some((t) => /also being changed/.test(t)));
  check("server stamped Alice on her payment", p1.payments.find((x) => x.amount === 300)?.username === "alice" && p1.payments.find((x) => x.amount === 300)?.recordedBy === "alice");

  // 3. True conflict: both change the same status note.
  await setNote(alice, "patient-p3", "Alice note");
  await setNote(bob, "patient-p3", "Bob note");
  state = await server();
  const bobToasts = await toasts(bob);
  check("same-field conflict keeps the first save", patient(state, "patient-p3").statusNote === "Alice note");
  check("second person is told their change was not saved", bobToasts.some((t) => /status note/.test(t) && /not saved/.test(t)), bobToasts.find((t) => /also/.test(t)) || "no toast");
  check("losing workstation now shows the saved value", (await noteOnScreen(bob, "patient-p3")) === "Alice note");

  // 4. Live updates without refresh.
  await sleep(9500);
  check("Alice sees Bob's and Carol's notes without refreshing", (await noteOnScreen(alice, "patient-p1")) === "Bob: mailed statement" && (await noteOnScreen(alice, "patient-p2")) === "Carol: call Tue");

  // 5. No live update while a dialog is open; applied once it closes.
  await carol.click('button[data-action="payments"][data-id="patient-p3"]');
  await carol.waitForSelector("#paymentsDialog[open]");
  await setNote(alice, "patient-p2", "Alice: updated while Carol busy");
  await sleep(9500);
  const whileOpen = await noteOnScreen(carol, "patient-p2");
  await carol.click('#paymentsDialog [data-close="paymentsDialog"]');
  await sleep(600);
  const afterClose = await noteOnScreen(carol, "patient-p2");
  check("remote change waits while a dialog is open", whileOpen === "Carol: call Tue", whileOpen);
  check("remote change appears once the dialog closes", afterClose === "Alice: updated while Carol busy", afterClose);

  // 6. Two payments on the same patient at the same moment.
  const before = patient(await server(), "patient-p3").payments.length;
  await Promise.all([recordPayment(alice, "patient-p3", 111), recordPayment(bob, "patient-p3", 222)]);
  const p3 = patient(await server(), "patient-p3");
  check("simultaneous payments on one patient are both recorded", p3.payments.length === before + 2 && p3.payments.some((x) => x.amount === 111) && p3.payments.some((x) => x.amount === 222), `payments ${before} -> ${p3.payments.length}`);
  check("no alerts during simultaneous payments", !alice.alerts.length && !bob.alerts.length, [...alice.alerts, ...bob.alerts].join(" | "));

  // 7. Tampering with the ledger directly (as a user could from the browser console).
  const tamper = await bob.evaluate(async () => {
    const current = (await (await fetch("/api/patients")).json()).patients.find((p) => p.id === "patient-p1");
    const data = JSON.parse(JSON.stringify(current.data));
    const target = data.payments.find((x) => x.amount === 300);
    target.amount = 3;                          // edit a recorded amount
    data.payments = data.payments.filter((x) => x.id !== data.payments[0].id || x === target); // drop another entry
    data.payments.push({ id: "payment-forged", type: "Payment", amount: 5, date: "2026-11-03", username: "alice", recordedBy: "alice", method: "Cash" });
    const response = await fetch(`/api/patients/${current.id}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": window.AckermanServer.csrfToken }, body: JSON.stringify({ revision: current.revision, patient: data }) });
    return { status: response.status, body: await response.json() };
  });
  const p1After = patient(await server(), "patient-p1");
  check("edited payment amount is refused", p1After.payments.some((x) => x.amount === 300) && !p1After.payments.some((x) => x.amount === 3));
  check("deleted payment is put back", p1After.payments.length === p1.payments.length + 1, `${p1.payments.length} -> ${p1After.payments.length}`);
  check("new entry is stamped with the real user, not the claimed one", p1After.payments.find((x) => x.id === "payment-forged")?.username === "bob" && p1After.payments.find((x) => x.id === "payment-forged")?.recordedBy === "bob");
  check("tampering is reported back", tamper.status === 200 && tamper.body.warnings.length === 2, tamper.body.warnings.join(" | "));

  // 8. Duplicate MRN is refused and does not get stuck in the page.
  await carol.click("#addPatientButton");
  await carol.waitForSelector("#patientDialog[open]");
  await carol.evaluate(() => {
    document.getElementById("patientName").value = "Dup Person";
    document.getElementById("patientMrn").value = "MRN1";
    document.getElementById("patientInsurance").value = "Cigna";
    const checkbox = document.querySelector('input[name="patientTreatmentFlag"]'); if (checkbox) checkbox.checked = true;
  });
  // The board's own MRN check runs first; bypass it to exercise the server check (two people adding the same MRN at once).
  const dupResult = await carol.evaluate(async () => {
    const r = await fetch("/api/patients/patient-dup", { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": window.AckermanServer.csrfToken }, body: JSON.stringify({ revision: 0, patient: { id: "patient-dup", name: "Dup", mrn: "mrn1", payments: [] } }) });
    return { status: r.status, body: await r.json() };
  });
  check("server refuses a second patient with the same MRN", dupResult.status === 400 && /MRN/.test(dupResult.body.message), dupResult.body.message);
  await carol.keyboard.press("Escape");

  // 9. A browser still running cached 3.2 code cannot overwrite the board.
  const old = await alice.evaluate(async () => (await fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": window.AckermanServer.csrfToken }, body: JSON.stringify({ revision: 1, patients: [] }) })).status);
  check("old whole-board save is refused", old === 409);
  state = await server();
  check("board still has every patient", state.patients.length === 3);

  // 10. Saves send only the changed patient.
  const sizes = [];
  alice.on("request", (r) => { if (r.method() === "PUT") sizes.push({ url: r.url(), bytes: (r.postData() || "").length }); });
  await setNote(alice, "patient-p2", "size check");
  check("a save sends one patient, not the board", sizes.length === 1 && /patient-p2$/.test(sizes[0].url), JSON.stringify(sizes));

  const errors = [alice, bob, carol].flatMap((p) => p.errors || []);
  check("no JavaScript errors on any page", errors.length === 0, errors.join(" | "));

  // Completed and Analytics pages still load with the per-patient data.
  for (const [path, sel] of [["/app/completed", "#completedTableBody"], ["/app/analytics", "main"]]) {
    await alice.goto(`${BASE}${path}`); await alice.waitForSelector(sel, { state: "attached" }); await sleep(500);
  }
  check("Completed and Analytics pages load", !(alice.errors || []).length, (alice.errors || []).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
