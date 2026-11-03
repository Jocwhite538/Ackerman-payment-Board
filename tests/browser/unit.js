// Unit tests: patient-merge.js and normalizePatient idempotency (data.js), run in a VM.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const ASSETS = process.argv[2];
const sandbox = { window: {}, console, Intl, Date, Math, JSON, crypto: require("crypto").webcrypto, setTimeout };
sandbox.window.crypto = sandbox.crypto; sandbox.window.AckermanSession = { username: "tester" };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${ASSETS}/patient-merge.js`, "utf8"), sandbox);
vm.runInContext(fs.readFileSync(`${ASSETS}/data.js`, "utf8"), sandbox);
const D = sandbox.window.AckermanData, M = sandbox.window.AckermanMerge;
let passed = 0; const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const today = D.todayIso();

const raw = { id: "patient-1", name: "Pat One", mrn: "MRN1", insurance: "Aetna", responsibility: 1200,
  collectionDate: today, treatments: ["Proton"], arrangement: "Payment Plan", collected: 200 };
const base = D.normalizePatient(raw);

test("normalizePatient is idempotent on a migrated legacy record", () => {
  assert.strictEqual(JSON.stringify(D.normalizePatient(clone(base))), JSON.stringify(base));
});
test("normalizePatient is idempotent after a payment, adjustment, completion", () => {
  const p = clone(base);
  D.addPaymentTransaction(p, { type: "Payment", amount: 100, date: today, officeSite: "ACC Mandarin", username: "a", responsibilityParty: "Ackerman", method: "Card", appliesToPlan: true });
  D.addAdjustment(p, { type: "Write-off", amount: 50, date: today, note: "x" });
  p.archived = true; p.completedAt = today; p.completionReason = "Paid in full";
  const n1 = D.normalizePatient(p), n2 = D.normalizePatient(clone(n1));
  assert.strictEqual(JSON.stringify(n2), JSON.stringify(n1));
});
test("server stamps survive normalization", () => {
  const p = clone(base); p.payments[0].recordedBy = "maria"; p.payments[0].recordedAtUtc = "2026-11-03T13:00:00Z";
  const n = D.normalizePatient(p);
  assert.strictEqual(n.payments[0].recordedBy, "maria"); assert.strictEqual(n.payments[0].recordedAtUtc, "2026-11-03T13:00:00Z");
});

function withPayment(p, amount, who) {
  const c = clone(p);
  D.addPaymentTransaction(c, { type: "Payment", amount, date: today, officeSite: "ACC Mandarin", username: who, responsibilityParty: "Ackerman", method: "Card", appliesToPlan: true });
  return D.normalizePatient(c);
}
function withNote(p, note) { const c = clone(p); c.statusNote = note; D.addActivity(c, { type: "account", title: "Status note updated", detail: note, date: today }); return D.normalizePatient(c); }

test("payment + status note by different people merge with no conflict", () => {
  const theirs = withPayment(base, 300, "alice"), mine = withNote(base, "Call Monday");
  const { patient, conflicts } = M.mergePatient(base, mine, theirs);
  const merged = D.normalizePatient(patient);
  assert.strictEqual(JSON.stringify(conflicts), JSON.stringify([]));
  assert.strictEqual(merged.statusNote, "Call Monday");
  assert.ok(merged.payments.some((x) => x.amount === 300));
  assert.strictEqual(merged.collected, 500); // 200 opening + 300
  assert.strictEqual(merged.activity.length, base.activity.length + 2);
});
test("two payments recorded at the same time are both kept", () => {
  const theirs = withPayment(base, 300, "alice"), mine = withPayment(base, 125.5, "bob");
  const { patient, conflicts } = M.mergePatient(base, mine, theirs);
  const merged = D.normalizePatient(patient);
  assert.strictEqual(JSON.stringify(conflicts), JSON.stringify([]));
  assert.strictEqual(merged.payments.length, base.payments.length + 2);
  assert.strictEqual(merged.collected, 625.5);
});
test("same field changed differently is a conflict and theirs wins", () => {
  const theirs = withNote(base, "Theirs"), mine = withNote(base, "Mine");
  const { patient, conflicts } = M.mergePatient(base, mine, theirs);
  assert.strictEqual(JSON.stringify(conflicts), JSON.stringify(["status note"]));
  assert.strictEqual(patient.statusNote, "Theirs");
  assert.strictEqual(D.normalizePatient(patient).activity.length, base.activity.length + 2); // both timeline entries kept
});
test("same field changed to the same value is not a conflict", () => {
  const { conflicts } = M.mergePatient(base, withNote(base, "Same"), withNote(base, "Same"));
  assert.strictEqual(JSON.stringify(conflicts), JSON.stringify([]));
});
test("account terms are merged as a unit", () => {
  const theirs = clone(base); theirs.responsibility = 1500;
  const mine = clone(base); mine.collectionDate = D.addDays(today, 7);
  const { patient, conflicts } = M.mergePatient(base, mine, theirs);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(patient.responsibility, 1500); assert.strictEqual(patient.collectionDate, base.collectionDate);
});
test("insurance edit + completion by different people combine", () => {
  const theirs = clone(base); theirs.archived = true; theirs.completedAt = today; theirs.completionReason = "Paid";
  const mine = clone(base); mine.insurance = "Cigna";
  const { patient, conflicts } = M.mergePatient(base, mine, theirs);
  assert.strictEqual(JSON.stringify(conflicts), JSON.stringify([]));
  assert.strictEqual(patient.insurance, "Cigna"); assert.strictEqual(patient.archived, true);
});
test("no base (retried create) merges identical copies cleanly", () => {
  const { patient, conflicts } = M.mergePatient(null, base, clone(base));
  assert.strictEqual(JSON.stringify(conflicts), JSON.stringify([]));
  assert.strictEqual(JSON.stringify(D.normalizePatient(patient)), JSON.stringify(base));
});
console.log(`${passed} unit tests passed`);
