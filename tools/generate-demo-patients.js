// Generates Source/Ackerman.PaymentBoard/DemoData/demo-patients.json using the
// board's own data.js, so every record has exactly the shape the board expects.
// All people are fictional. IDs start with "demo-" and MRNs with "DEMO-".
// Dates are written relative to anchorDate; the server shifts them so the demo
// board always looks current (some payments due today, some overdue, and so on).
//
// Usage: node tools/generate-demo-patients.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "Source/Ackerman.PaymentBoard/wwwroot/assets");
const OUT = path.join(ROOT, "Source/Ackerman.PaymentBoard/DemoData/demo-patients.json");

const sandbox = { window: { AckermanSession: { username: "demo" } }, console, Intl, Date, Math, JSON };
sandbox.window.crypto = require("crypto").webcrypto; sandbox.crypto = sandbox.window.crypto;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ASSETS, "data.js"), "utf8"), sandbox);
const D = sandbox.window.AckermanData;
const T = D.todayIso();
const day = (offset) => D.addDays(T, offset);
const STAFF = ["mgarcia", "tlee", "frontdesk.jax", "rpatel", "kwilliams"];
const clone = (x) => JSON.parse(JSON.stringify(x));

let serial = 0;
function patient(spec) {
  serial += 1;
  const id = `demo-${String(serial).padStart(3, "0")}`;
  const mrn = `DEMO-${1000 + serial}`;
  const created = day(spec.createdOffset ?? -30);
  const base = {
    id, mrn, name: spec.name, location: spec.site || "Jacksonville",
    treatments: spec.treatments || ["Clinic"], insurance: spec.insurance || "Florida Blue",
    responsibility: spec.responsibility || 0, collectionDate: created,
    arrangement: spec.noResponsibility ? "No Responsibility" : "Payment Plan",
    status: spec.noResponsibility ? "No Responsibility" : "Payment Plan",
    noResponsibilityReason: spec.noResponsibility || "", statusNote: spec.statusNote || "", notes: spec.notes || "",
    createdAt: `${created}T08:00:00`, ledgerInitialized: true, payments: [], adjustments: [], activity: []
  };
  if (!spec.noResponsibility) {
    const installments = D.makePlanSchedule(spec.responsibility, spec.count || 1, day(spec.firstDue ?? 0), spec.frequency || "monthly")
      .map((item, index) => ({ ...item, id: `${id}-inst-${index + 1}`, responsibilityParty: (spec.uf || []).includes(index) ? "UF" : "Ackerman" }));
    base.paymentPlan = { createdDate: created, openingCollected: 0, promiseToPayDate: spec.promise ? day(spec.promise) : "", renegotiationCount: 0, history: [], installments };
    base.collectionDate = installments[0].dueDate;
  }
  let p = D.normalizePatient(base);
  let n = 0;
  for (const pay of spec.payments || []) {
    n += 1;
    const inst = pay.inst !== undefined ? p.paymentPlan.installments[pay.inst] : null;
    const date = day(pay.offset ?? (inst ? D.daysBetween(T, inst.dueDate) : -1));
    if (date >= T) throw new Error(`${spec.name}: payment dated today or later`);
    D.addPaymentTransaction(p, {
      id: `${id}-pay-${n}`, type: pay.type || "Payment", amount: pay.amount ?? inst.amount, date,
      officeSite: pay.office || "ACC Mandarin", username: pay.user || STAFF[(serial + n) % STAFF.length],
      responsibilityParty: pay.party || inst?.responsibilityParty || "Ackerman", installmentId: inst ? inst.id : "",
      method: pay.method || "Credit/Debit Card", note: pay.note || "", appliesToPlan: true,
      relatedTransactionId: pay.related ? `${id}-pay-${pay.related}` : "", createdAt: `${date}T${10 + (n % 6)}:${String((n * 7) % 60).padStart(2, "0")}:00`
    });
  }
  for (const adj of spec.adjustments || []) {
    n += 1;
    const date = day(adj.offset);
    D.addAdjustment(p, { id: `${id}-adj-${n}`, type: adj.type, amount: adj.amount, date, note: adj.note || "", createdAt: `${date}T14:20:00` });
  }
  if (spec.completed) {
    const date = day(spec.completed.offset);
    p.archived = true; p.completedAt = date; p.completionReason = spec.completed.reason; p.completionNote = spec.completed.note || "";
    D.addActivity(p, { type: "completion", title: "Account completed and archived", detail: `Reason: ${spec.completed.reason}.`, date });
  }
  if (spec.statusNote) D.addActivity(p, { type: "account", title: "Status note updated", detail: spec.statusNote, date: day(-1) });
  // Give every timeline entry a time on its own date (never later than yesterday).
  p.activity.forEach((entry, index) => { entry.createdAt = `${entry.date}T${String(9 + (index % 8)).padStart(2, "0")}:${String((index * 13) % 60).padStart(2, "0")}:00`; });
  p.updatedAt = "";
  p = D.normalizePatient(p);
  const again = D.normalizePatient(clone(p));
  if (JSON.stringify(again) !== JSON.stringify(p)) throw new Error(`${spec.name}: normalization is not stable`);
  return p;
}

const specs = [
  { name: "Marisol Vega", site: "Jacksonville", treatments: ["Proton"], insurance: "Florida Blue", responsibility: 2400, count: 6, firstDue: -60, createdOffset: -75, payments: [{ inst: 0 }, { inst: 1, method: "ACH" }] },
  { name: "Theodore Banks", site: "Amelia Island", treatments: ["Radiation (Linac/HDR/Other)"], insurance: "Aetna", responsibility: 1800, count: 3, firstDue: -45, createdOffset: -50, payments: [{ inst: 0, office: "ACC Amelia Island" }], statusNote: "Left voicemail" },
  { name: "Priya Raman", site: "Jacksonville", treatments: ["Imaging"], insurance: "Cigna", responsibility: 350, count: 1, firstDue: 0, createdOffset: -12 },
  { name: "Walter Okafor", site: "Jacksonville", treatments: ["Proton"], insurance: "Medicare + supplement", responsibility: 4200, count: 12, firstDue: -150, createdOffset: -160, payments: [0, 1, 2, 3, 4].map((i) => ({ inst: i, method: "ACH" })) },
  { name: "Hannah Lindqvist", site: "Urology World Golf Village", treatments: ["Women's Imaging"], insurance: "UnitedHealthcare", responsibility: 275, count: 1, firstDue: 7, createdOffset: -5 },
  { name: "Desmond Hale", site: "Urology Middleburg", treatments: ["Radiation (Linac/HDR/Other)", "Clinic"], insurance: "Humana", responsibility: 3000, count: 6, firstDue: -40, createdOffset: -55, uf: [1, 2], payments: [{ inst: 0, office: "Urology Middleburg" }], statusNote: "Confirm UF check received" },
  { name: "Rosa Delgado", site: "Jacksonville", treatments: ["Clinic"], insurance: "Florida Blue", noResponsibility: "Covered in full by insurance", createdOffset: -20 },
  { name: "Gregory Pham", site: "Jacksonville", treatments: ["Proton"], insurance: "Tricare", responsibility: 1200, count: 6, frequency: "biweekly", firstDue: -80, createdOffset: -85, payments: [0, 1, 2, 3, 4, 5].map((i) => ({ inst: i })) },
  { name: "Naomi Fitzgerald", site: "Amelia Island", treatments: ["Radiation (Linac/HDR/Other)"], insurance: "Aetna", responsibility: 2000, count: 4, firstDue: -35, createdOffset: -40, payments: [{ inst: 0, method: "Check" }, { type: "Reversal", amount: 500, offset: -30, related: 1, method: "Check", note: "Check returned by bank" }], statusNote: "Returned check - call patient" },
  { name: "Calvin Brooks", site: "Jacksonville", treatments: ["Imaging"], insurance: "Self-pay", responsibility: 900, count: 3, firstDue: -20, createdOffset: -30, payments: [{ inst: 0, method: "Cash", office: "ACC Mandarin" }], adjustments: [{ type: "Financial Assistance", amount: 150, offset: -15, note: "Approved under assistance policy" }] },
  { name: "Imani Carter", site: "Jacksonville", treatments: ["Proton"], insurance: "Cigna", responsibility: 5500, count: 4, frequency: "quarterly", firstDue: -100, createdOffset: -110, payments: [{ inst: 0, method: "ACH" }], promise: 5, statusNote: "Promised payment by Friday" },
  { name: "Oliver Strand", site: "Urology World Golf Village", treatments: ["Clinic"], insurance: "Medicare", responsibility: 150, count: 1, firstDue: -3, createdOffset: -10 },
  { name: "Lucia Moretti", site: "Jacksonville", treatments: ["Women's Imaging"], insurance: "Florida Blue", responsibility: 425, count: 2, firstDue: -25, createdOffset: -30, payments: [{ inst: 0, method: "Online Portal", office: "Other" }] },
  { name: "Samuel Achebe", site: "Urology Middleburg", treatments: ["Radiation (Linac/HDR/Other)"], insurance: "UnitedHealthcare", responsibility: 2750, count: 8, frequency: "weekly", firstDue: -28, createdOffset: -35, payments: [0, 1, 2, 3].map((i) => ({ inst: i, office: "Urology Middleburg" })) },
  { name: "Beatrice Holloway", site: "Jacksonville", treatments: ["Proton"], insurance: "Aetna", responsibility: 1500, count: 3, firstDue: -120, createdOffset: -130, payments: [0, 1, 2].map((i) => ({ inst: i })), completed: { offset: -50, reason: "Treatment completed" } },
  { name: "Franklin Reyes", site: "Amelia Island", treatments: ["Imaging"], insurance: "Humana", responsibility: 800, count: 2, firstDue: -90, createdOffset: -95, payments: [{ inst: 0, office: "ACC Amelia Island" }], adjustments: [{ type: "Write-off", amount: 400, offset: -60, note: "Balance written off after cancellation" }], completed: { offset: -60, reason: "Patient cancelled treatment" } },
  { name: "Yuki Tanaka", site: "Jacksonville", treatments: ["Radiation (Linac/HDR/Other)", "Clinic"], insurance: "Cigna", responsibility: 2100, count: 3, firstDue: -70, createdOffset: -80, payments: [{ inst: 0 }], completed: { offset: -40, reason: "Transferred / referred elsewhere", note: "Care transferred to another provider" } },
  { name: "Margaret O'Neil", site: "Jacksonville", treatments: ["Proton"], insurance: "Aetna", responsibility: 3600, count: 6, firstDue: 5, createdOffset: -2 },
  { name: "Andre Thibodeaux", site: "Amelia Island", treatments: ["Radiation (Linac/HDR/Other)"], insurance: "Humana", responsibility: 1350, count: 3, firstDue: -30, createdOffset: -35, uf: [0, 1, 2], payments: [{ inst: 0, party: "UF", method: "Check", office: "ACC Amelia Island", note: "UF check received" }] },
  { name: "Elena Petrov", site: "Jacksonville", treatments: ["Imaging", "Clinic"], insurance: "Cigna", responsibility: 600, count: 2, firstDue: -40, createdOffset: -45, payments: [{ inst: 0 }, { inst: 1, amount: 350, offset: -10 }, { type: "Refund", amount: 50, offset: -8, related: 2, note: "Overpayment refunded" }] },
  { name: "Jamal Whitaker", site: "Jacksonville", treatments: ["Proton"], insurance: "Florida Blue", responsibility: 2200, count: 4, firstDue: -50, createdOffset: -55, payments: [{ inst: 0, amount: 5500, offset: -50, note: "Entered with a typo" }, { type: "Correction Reversal", amount: 5500, offset: -49, related: 1, note: "Amount entered incorrectly" }, { type: "Correction Payment", amount: 550, offset: -49, inst: 0, note: "Corrected amount" }, { inst: 1 }] },
  { name: "Sophie Laurent", site: "Urology Middleburg", treatments: ["Clinic"], insurance: "Self-pay", responsibility: 250, count: 1, firstDue: 14, createdOffset: -3 },
  { name: "Victor Nakamura", site: "Urology World Golf Village", treatments: ["Radiation (Linac/HDR/Other)"], insurance: "Medicare", responsibility: 1000, count: 2, firstDue: -100, createdOffset: -110, uf: [1], payments: [{ inst: 0 }, { inst: 1, party: "UF", method: "Check" }], completed: { offset: -30, reason: "Treatment completed" } },
  { name: "Grace Adeyemi", site: "Jacksonville", treatments: ["Radiation (Linac/HDR/Other)"], insurance: "Medicare", responsibility: 1950, count: 6, firstDue: -90, createdOffset: -95, payments: [0, 1, 2].map((i) => ({ inst: i })) }
];

const patients = specs.map(patient);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  description: "Fictional demo patients for development and test sites only. Loaded when Demo:SeedPatients is true and the board is empty.",
  anchorDate: T,
  patients
}, null, 2) + "\n");

// Coverage report
const rows = patients.map((p) => ({ name: p.name, status: p.archived ? `Completed (${p.completionReason})` : D.attentionStatus(p), owed: D.amountOwed(p), payments: p.payments.length }));
console.table(rows);
console.log(`wrote ${patients.length} demo patients to ${path.relative(ROOT, OUT)}`);
