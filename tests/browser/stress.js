// Stress: N users hammer the same few patients with payments and status notes.
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://localhost:5099";
const USERS = Number(process.argv[3] || 8), ROUNDS = Number(process.argv[4] || 4);
const IDS = (process.env.STRESS_IDS || "patient-p1,patient-p2,patient-p3").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, user) {
  const page = await (await browser.newContext()).newPage();
  page.alerts = []; page.errors = [];
  page.on("dialog", async (d) => { page.alerts.push(d.message()); await d.accept(); });
  page.on("pageerror", (e) => page.errors.push(String(e)));
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
  await page.evaluate(() => { for (const sel of ["#paymentOfficeSite", "#paymentMethod"]) { const s = document.querySelector(sel); s.value = [...s.options].find((o) => o.value).value; } });
  await page.click('#paymentForm button[type="submit"]');
  await page.waitForSelector("#paymentDialog", { state: "hidden" });
  await page.click('#paymentsDialog [data-close="paymentsDialog"]');
  await page.waitForSelector("#paymentsDialog", { state: "hidden" });
}
async function setNote(page, id, note) {
  const input = page.locator(`input[data-status-note-id="${id}"]`);
  await input.fill(note); await input.press("Tab"); await sleep(50);
}

(async () => {
  const browser = await chromium.launch();
  const pages = [];
  for (let u = 0; u < USERS; u++) pages.push(await open(browser, `user${u}`));
  const expectedPayments = [];
  const t0 = Date.now();
  await Promise.all(pages.map(async (page, u) => {
    for (let r = 0; r < ROUNDS; r++) {
      const id = IDS[(u + r) % IDS.length];
      if ((u + r) % 2 === 0) {
        const amount = Number(`${u + 1}${r + 1}.${String(u).padStart(2, "0")}`);
        expectedPayments.push({ id, amount });
        try { await recordPayment(page, id, amount); }
        catch (e) {
          const toastsNow = await page.$$eval(".toast", (els) => els.map((x) => x.textContent));
          console.log(`FAILED user${u} r${r} ${id} ${amount}`, JSON.stringify({ alerts: page.alerts, toasts: toastsNow, errors: page.errors }));
          throw e;
        }
      } else {
        await setNote(page, id, `note u${u} r${r}`);
      }
    }
  }));
  const elapsed = Date.now() - t0;
  const state = await (await fetch(`${BASE}/__state`)).json();
  const lost = expectedPayments.filter((e) => !state.patients.find((p) => p.id === e.id).data.payments.some((x) => x.amount === e.amount));
  const dupIds = state.patients.flatMap((p) => { const ids = p.data.payments.map((x) => x.id); return ids.filter((x, i) => ids.indexOf(x) !== i); });
  const wrongStamp = state.patients.flatMap((p) => p.data.payments).filter((x) => x.recordedBy && x.username !== x.recordedBy);

  await sleep(10000); // one poll cycle
  const mismatches = [];
  for (const page of pages) for (const id of IDS) {
    const shown = await page.$eval(`input[data-status-note-id="${id}"]`, (el) => el.value);
    const saved = state.patients.find((p) => p.id === id).data.statusNote;
    if (shown !== saved) mismatches.push(`${id}: shows "${shown}", saved "${saved}"`);
  }
  const alerts = pages.flatMap((p) => p.alerts), errors = pages.flatMap((p) => p.errors);
  const conflictToasts = state.audit.filter((a) => a.action === "Ledger change refused").length;
  console.log(JSON.stringify({ users: USERS, actions: USERS * ROUNDS, payments: expectedPayments.length, elapsedMs: elapsed, lostPayments: lost.length, duplicatePaymentIds: dupIds.length, wrongStamps: wrongStamp.length, screensOutOfSync: mismatches.length, alerts, jsErrors: errors.length, ledgerRefusals: conflictToasts, saves: state.history.length - 3 }, null, 1));
  if (mismatches.length) console.log(mismatches.slice(0, 5));
  await browser.close();
  process.exit(lost.length || dupIds.length || wrongStamp.length || mismatches.length || alerts.length || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
