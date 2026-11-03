const fs = require("fs"), vm = require("vm");
const ASSETS = process.argv[2];
const sb = { window: { AckermanSession: { username: "seed" } }, console, Intl, Date, Math, JSON };
sb.window.crypto = require("crypto").webcrypto; sb.crypto = sb.window.crypto;
vm.createContext(sb); vm.runInContext(fs.readFileSync(`${ASSETS}/data.js`, "utf8"), sb);
const D = sb.window.AckermanData, today = D.todayIso();
const mk = (id, name, mrn, extra = {}) => D.normalizePatient({ id, name, mrn, insurance: "Aetna", responsibility: 1200, collectionDate: today, treatments: ["Proton"], arrangement: "Payment Plan", location: "Jacksonville", ...extra });
const patients = [mk("patient-p1", "Pat One", "MRN1", { collected: 200 }), mk("patient-p2", "Pat Two", "MRN2"), mk("patient-p3", "Pat Three", "MRN3"),
  mk("demo-123", "Demo Person", "D1"), mk("patient-x", "Demo Two", "DEMO-77")];
fs.writeFileSync("legacy.json", JSON.stringify({ revision: 42, updatedBy: "jwhite", patients }));
console.log("seeded", patients.length);
