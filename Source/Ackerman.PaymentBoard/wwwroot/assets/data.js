(function () {
  "use strict";

  const STORAGE_KEY = "ackermanPaymentPrototypeV5";
  const LEGACY_STORAGE_KEYS = ["ackermanPaymentPrototypeV4", "ackermanPaymentPrototypeV3", "ackermanPaymentPrototypeV2", "ackermanPaymentPrototypeV1"];
  const SAVED_VIEW_USER = String(window.AckermanSession?.username || "local").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "local";
  const SAVED_VIEWS_KEY = `ackermanPaymentSavedViewsV5_${SAVED_VIEW_USER}`;
  const LEGACY_SAVED_VIEWS_KEYS = ["ackermanPaymentSavedViewsV4"];
  const EPSILON = 0.005;
  const TREATMENT_FLAGS = [
    "Proton",
    "Radiation (Linac/HDR/Other)",
    "Imaging",
    "Clinic",
    "Women's Imaging"
  ];
  const OFFICE_SITES = [
    "ACC Mandarin",
    "ACC Amelia Island",
    "ACC St. Augustine",
    "Urology World Golf Village",
    "Urology Middleburg",
    "Other"
  ];

  const currency = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  });

  function toIsoLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function todayIso() {
    return toIsoLocal(new Date());
  }

  function parseIsoDate(isoDate) {
    const parts = String(isoDate || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  }

  function dateOffset(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return toIsoLocal(date);
  }

  function addDays(isoDate, days) {
    const date = parseIsoDate(isoDate) || new Date();
    date.setDate(date.getDate() + Number(days || 0));
    return toIsoLocal(date);
  }

  function addMonths(isoDate, months) {
    const source = parseIsoDate(isoDate) || new Date();
    const originalDay = source.getDate();
    source.setDate(1);
    source.setMonth(source.getMonth() + Number(months || 0));
    const lastDay = new Date(source.getFullYear(), source.getMonth() + 1, 0).getDate();
    source.setDate(Math.min(originalDay, lastDay));
    return toIsoLocal(source);
  }

  function daysBetween(fromIso, toIso) {
    const from = parseIsoDate(fromIso);
    const to = parseIsoDate(toIso);
    if (!from || !to) return 0;
    return Math.round((to - from) / 86400000);
  }

  function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix = "patient") {
    const random = window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function splitAmount(total, count) {
    const safeCount = Math.max(1, Math.floor(Number(count || 1)));
    const cents = Math.max(0, Math.round(Number(total || 0) * 100));
    const base = Math.floor(cents / safeCount);
    let remainder = cents - (base * safeCount);
    return Array.from({ length: safeCount }, () => {
      const amount = base + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      return amount / 100;
    });
  }

  function scheduleDate(firstDate, index, frequency) {
    if (frequency === "weekly") return addDays(firstDate, index * 7);
    if (frequency === "biweekly") return addDays(firstDate, index * 14);
    if (frequency === "quarterly") return addMonths(firstDate, index * 3);
    return addMonths(firstDate, index);
  }

  function makePlanSchedule(total, count, firstDate, frequency = "monthly") {
    const amounts = splitAmount(total, count);
    const start = firstDate || todayIso();
    return amounts.map((amount, index) => {
      const dueDate = scheduleDate(start, index, frequency);
      return {
        id: uid("installment"),
        dueDate,
        originalDueDate: dueDate,
        amount,
        responsibilityParty: "Ackerman",
        ufVerified: false,
        ufVerifiedAt: "",
        rescheduledAt: ""
      };
    });
  }

  function planRecord(total, count, firstDate, frequency, openingCollected = 0, createdDate = todayIso()) {
    return {
      createdDate,
      openingCollected: Math.max(0, Number(openingCollected || 0)),
      promiseToPayDate: "",
      renegotiationCount: 0,
      history: [],
      installments: makePlanSchedule(total, count, firstDate, frequency)
    };
  }

  function seedPatients() {
    return [];
  }

  function arrangementFromLegacy(patient) {
    const explicit = String(patient.arrangement || "");
    if (explicit === "No Responsibility" || patient.status === "No Responsibility" || Number(patient.responsibility || 0) <= 0) return "No Responsibility";
    // Version 5.4 uses only two arrangements. Legacy Standard Collection
    // accounts are migrated to a one-payment Payment Plan.
    return "Payment Plan";
  }

  function normalizeTreatmentSite(value) {
    const raw = String(value || "").trim();
    const map = {
      "Jacksonville": "Jacksonville",
      "Amelia Island": "Amelia Island",
      "St. Augustine": "Jacksonville",
      "Urology World Golf Village": "Urology World Golf Village",
      "Urology WGV": "Urology World Golf Village",
      "Urology Whereock Village": "Urology World Golf Village",
      "World Golf Village": "Urology World Golf Village",
      "Urology Middleburg": "Urology Middleburg",
      "Middleburg": "Urology Middleburg",
      "Orange Park": "Urology Middleburg"
    };
    return map[raw] || "Jacksonville";
  }

  function normalizeTreatmentType(value) {
    const raw = String(value || "").trim();
    const map = {
      "Proton Therapy": "Proton",
      "Proton": "Proton",
      "Radiation Therapy": "Radiation (Linac/HDR/Other)",
      "Radiation (Linac/HDR/Other)": "Radiation (Linac/HDR/Other)",
      "Radiation (Linac / HDR / Other)": "Radiation (Linac/HDR/Other)",
      "Imaging": "Imaging",
      "Consultation": "Clinic",
      "Clinic": "Clinic",
      "Woman Imaging": "Women's Imaging",
      "Women Imaging": "Women's Imaging",
      "Women's Imaging": "Women's Imaging",
      "Womens Imaging": "Women's Imaging"
    };
    return map[raw] || "Clinic";
  }

  function normalizeTreatments(value) {
    const rawValues = Array.isArray(value)
      ? value
      : String(value || "").split(/\s*(?:[|,+]|·)\s*/).filter(Boolean);
    const normalized = rawValues.map(normalizeTreatmentType);
    const unique = [...new Set(normalized)].filter((item) => TREATMENT_FLAGS.includes(item));
    return unique.length ? unique : ["Clinic"];
  }

  function patientTreatments(patient) {
    if (Array.isArray(patient?.treatments) && patient.treatments.length) return normalizeTreatments(patient.treatments);
    return normalizeTreatments(patient?.treatment || "Clinic");
  }

  function treatmentLabel(patient) {
    return patientTreatments(patient).join(" · ");
  }

  function normalizeTransactionType(value) {
    const type = String(value || "Payment");
    const allowed = ["Payment", "Reversal", "Refund", "Correction Reversal", "Correction Payment"];
    return allowed.includes(type) ? type : "Payment";
  }

  function transactionEffect(payment) {
    const type = normalizeTransactionType(payment?.type);
    const amount = Math.max(0, Number(payment?.amount || 0));
    return ["Reversal", "Refund", "Correction Reversal"].includes(type) ? -amount : amount;
  }

  function normalizePayment(payment, patient) {
    const rawAmount = Number(payment.amount || 0);
    let type = normalizeTransactionType(payment.type);
    if (rawAmount < 0 && type === "Payment") type = "Reversal";
    const responsibilityParty = String(payment.responsibilityParty || payment.party || "Ackerman") === "UF" ? "UF" : "Ackerman";
    const legacyLocation = String(payment.location || patient.location || "Jacksonville");
    return {
      id: String(payment.id || uid("payment")),
      type,
      amount: Math.max(0, Math.abs(rawAmount)),
      date: String(payment.date || patient.collectionDate || todayIso()),
      location: normalizeTreatmentSite(legacyLocation),
      officeSite: String(payment.officeSite || payment.collectionSite || legacyLocation || "Not entered"),
      username: String(payment.username || payment.actor || ""),
      responsibilityParty,
      installmentId: String(payment.installmentId || payment.scheduledPaymentId || ""),
      method: String(payment.method || "Other"),
      note: String(payment.note || ""),
      appliesToPlan: Boolean(payment.appliesToPlan || payment.planPayment || payment.installmentId || payment.scheduledPaymentId),
      relatedTransactionId: String(payment.relatedTransactionId || ""),
      createdAt: String(payment.createdAt || `${payment.date || patient.collectionDate || todayIso()}T12:00:00`),
      ...serverStamps(payment)
    };
  }

  // Version 3.3: the server stamps who recorded each ledger entry and when.
  // Keep those stamps when the entry is normalized in the browser.
  function serverStamps(entry) {
    const stamps = {};
    if (entry.recordedBy) stamps.recordedBy = String(entry.recordedBy);
    if (entry.recordedAtUtc) stamps.recordedAtUtc = String(entry.recordedAtUtc);
    return stamps;
  }

  function normalizeAdjustment(adjustment) {
    const allowed = ["Adjustment", "Write-off", "Financial Assistance", "Insurance Reallocation"];
    const type = allowed.includes(String(adjustment.type || "")) ? String(adjustment.type) : "Adjustment";
    return {
      id: String(adjustment.id || uid("adjustment")),
      type,
      amount: Math.max(0, Number(adjustment.amount || 0)),
      date: String(adjustment.date || todayIso()),
      note: String(adjustment.note || ""),
      createdAt: String(adjustment.createdAt || `${adjustment.date || todayIso()}T12:00:00`),
      ...serverStamps(adjustment)
    };
  }

  function normalizeActivity(activity) {
    const requestedCreatedAt = String(activity.createdAt || `${activity.date || todayIso()}T12:00:00`);
    const requestedTime = new Date(requestedCreatedAt).getTime();
    const createdAt = Number.isFinite(requestedTime) && requestedTime <= Date.now() + 60000
      ? requestedCreatedAt
      : new Date().toISOString();
    return {
      id: String(activity.id || uid("activity")),
      type: String(activity.type || "account"),
      title: String(activity.title || "Account activity"),
      detail: String(activity.detail || ""),
      date: String(activity.date || todayIso()),
      createdAt,
      actor: String(activity.actor || "System user")
    };
  }

  function normalizePlan(plan) {
    if (!plan || !Array.isArray(plan.installments) || plan.installments.length === 0) return null;
    const installments = plan.installments
      .map((installment, index) => {
        const dueDate = String(installment.dueDate || todayIso());
        const responsibilityParty = String(installment.responsibilityParty || installment.owner || "Ackerman") === "UF" ? "UF" : "Ackerman";
        return {
          id: String(installment.id || uid(`installment-${index + 1}`)),
          dueDate,
          originalDueDate: String(installment.originalDueDate || dueDate),
          amount: Math.max(0, Number(installment.amount || 0)),
          responsibilityParty,
          ufVerified: responsibilityParty === "UF" ? Boolean(installment.ufVerified) : false,
          ufVerifiedAt: responsibilityParty === "UF" ? String(installment.ufVerifiedAt || "") : "",
          rescheduledAt: String(installment.rescheduledAt || "")
        };
      })
      .filter((installment) => installment.amount > EPSILON)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    if (!installments.length) return null;
    return {
      createdDate: String(plan.createdDate || todayIso()),
      openingCollected: Math.max(0, Number(plan.openingCollected || 0)),
      promiseToPayDate: String(plan.promiseToPayDate || ""),
      renegotiationCount: Math.max(0, Math.floor(Number(plan.renegotiationCount || 0))),
      history: Array.isArray(plan.history) ? plan.history.map((entry) => ({
        id: String(entry.id || uid("plan-history")),
        date: String(entry.date || todayIso()),
        reason: String(entry.reason || "Plan schedule updated"),
        detail: String(entry.detail || ""),
        createdAt: String(entry.createdAt || `${entry.date || todayIso()}T12:00:00`)
      })) : [],
      installments
    };
  }

  function defaultMigratedPlan(patient) {
    const total = Math.max(0, Number(patient.responsibility || 0));
    if (total <= EPSILON) return null;
    const firstDate = String(patient.collectionDate || todayIso());
    // A former Standard Collection account becomes a single-installment plan.
    // Existing ledger payments are inferred into this plan by planPaymentEvents().
    return planRecord(total, 1, firstDate, "monthly", 0, patient.createdAt?.slice(0, 10) || todayIso());
  }

  function inferCompletionDate(patient, payments) {
    if (!patient.archived) return "";
    if (patient.completedAt) return String(patient.completedAt);
    const dates = payments.map((payment) => payment.date).filter(Boolean).sort();
    return dates[dates.length - 1] || String(patient.collectionDate || todayIso());
  }

  function paymentTitle(payment) {
    if (payment.type === "Reversal") return "Payment reversed";
    if (payment.type === "Refund") return "Payment refunded";
    if (payment.type === "Correction Reversal") return "Original payment corrected";
    if (payment.type === "Correction Payment") return "Corrected payment recorded";
    return "Payment recorded";
  }

  function buildInitialActivities(patient) {
    const activities = [];
    const push = (entry) => activities.push(normalizeActivity(entry));
    const createdDate = patient.paymentPlan?.createdDate || patient.collectionDate || todayIso();
    push({
      id: `activity-${patient.id}-created`,
      type: "account",
      title: "Patient account created",
      detail: `${patient.arrangement} account with ${currency.format(patient.responsibility)} responsibility.`,
      date: createdDate,
      createdAt: `${createdDate}T08:00:00`
    });
    patient.payments.forEach((payment) => push({
      id: `activity-${payment.id}`,
      type: "payment",
      title: paymentTitle(payment),
      detail: `${currency.format(payment.amount)} · ${payment.method}${payment.note ? ` · ${payment.note}` : ""}`,
      date: payment.date,
      createdAt: payment.createdAt
    }));
    patient.adjustments.forEach((adjustment) => push({
      id: `activity-${adjustment.id}`,
      type: "adjustment",
      title: `${adjustment.type} recorded`,
      detail: `${currency.format(adjustment.amount)}${adjustment.note ? ` · ${adjustment.note}` : ""}`,
      date: adjustment.date,
      createdAt: adjustment.createdAt
    }));
    if (patient.archived && patient.completedAt) push({
      id: `activity-${patient.id}-completed`,
      type: "completion",
      title: "Account completed and archived",
      detail: patient.completionReason ? `Reason: ${patient.completionReason}.${patient.completionNote ? ` Note: ${patient.completionNote}` : ""}` : "Moved from the active work queue to Completed Patients.",
      date: patient.completedAt,
      createdAt: `${patient.completedAt}T17:00:00`
    });
    return activities.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function normalizePatient(patient) {
    const arrangement = arrangementFromLegacy(patient);
    const base = {
      id: String(patient.id || uid("patient")),
      name: String(patient.name || ""),
      mrn: String(patient.mrn || ""),
      location: normalizeTreatmentSite(patient.location || "Jacksonville"),
      treatments: normalizeTreatments(patient.treatments || patient.treatment),
      treatment: normalizeTreatments(patient.treatments || patient.treatment).join(" · "),
      insurance: String(patient.insurance || "Not entered"),
      responsibility: Math.max(0, Number(patient.responsibility || 0)),
      collected: Math.max(0, Number(patient.collected || 0)),
      ledgerInitialized: true,
      collectionDate: String(patient.collectionDate || todayIso()),
      status: String(patient.status || "Upcoming Collection"),
      arrangement,
      noResponsibilityReason: String(patient.noResponsibilityReason || (arrangement === "No Responsibility" ? patient.notes || "No patient responsibility" : "")),
      statusNote: String(patient.statusNote || ""),
      notes: String(patient.notes || ""),
      archived: Boolean(patient.archived),
      completedAt: "",
      completionReason: String(patient.completionReason || ""),
      completionNote: String(patient.completionNote || ""),
      createdAt: String(patient.createdAt || ""),
      updatedAt: String(patient.updatedAt || ""),
      paymentPlan: null,
      payments: [],
      adjustments: [],
      activity: []
    };

    base.payments = Array.isArray(patient.payments)
      ? patient.payments.map((payment) => normalizePayment(payment, base))
      : [];

    const ledgerTotal = base.payments.reduce((sum, payment) => sum + transactionEffect(payment), 0);
    const missingOpening = base.collected - ledgerTotal;
    // Reconcile the legacy summary field only once during migration. Once a
    // transaction ledger is initialized, reversals/refunds must not be
    // silently replaced by a synthetic opening payment.
    if (patient.ledgerInitialized !== true && missingOpening > EPSILON) {
      base.payments.push(normalizePayment({
        id: uid("payment-opening"),
        type: "Payment",
        amount: missingOpening,
        date: base.collectionDate,
        location: base.location,
        method: "Previously Collected",
        note: "Opening amount recorded before detailed payment history.",
        appliesToPlan: false
      }, base));
    }

    base.adjustments = Array.isArray(patient.adjustments)
      ? patient.adjustments.map(normalizeAdjustment).filter((entry) => entry.amount > EPSILON)
      : [];
    base.paymentPlan = normalizePlan(patient.paymentPlan);
    if (!base.paymentPlan && arrangement === "Payment Plan") base.paymentPlan = defaultMigratedPlan(base);

    // Version 2.1 migration: a historical UF verification becomes a real UF
    // ledger entry linked to that scheduled payment. After migration the ledger,
    // not a checkbox, is the source of truth for whether UF paid.
    if (base.paymentPlan) {
      base.paymentPlan.installments.forEach((installment) => {
        if (installment.responsibilityParty !== "UF" || !installment.ufVerified) return;
        const existing = base.payments.some((payment) => payment.installmentId === installment.id && payment.responsibilityParty === "UF" && transactionEffect(payment) > EPSILON);
        if (!existing) {
          base.payments.push(normalizePayment({
            id: uid("payment-uf-migrated"),
            type: "Payment",
            amount: installment.amount,
            date: installment.ufVerifiedAt || installment.dueDate || todayIso(),
            officeSite: base.location,
            location: base.location,
            username: "Migrated UF verification",
            responsibilityParty: "UF",
            installmentId: installment.id,
            method: "UF verification (migrated)",
            note: "Converted from the previous Check UF verification record.",
            appliesToPlan: true
          }, base));
        }
        installment.ufVerified = false;
        installment.ufVerifiedAt = "";
      });
    }

    base.collected = Math.max(0, Math.round(base.payments.reduce((sum, payment) => sum + transactionEffect(payment), 0) * 100) / 100);
    base.completedAt = inferCompletionDate(patient, base.payments);
    base.activity = Array.isArray(patient.activity) && patient.activity.length
      ? patient.activity.map(normalizeActivity).filter((entry) => entry.type !== "outcome").sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : buildInitialActivities(base);

    const isUsableTimestamp = (value) => {
      const time = new Date(value).getTime();
      return Boolean(value) && Number.isFinite(time) && time <= Date.now() + 60000;
    };
    const activityTimes = base.activity.map((entry) => entry.createdAt).filter(isUsableTimestamp).sort();
    const fallbackDateCandidate = base.paymentPlan?.createdDate || base.collectionDate || todayIso();
    const fallbackDate = fallbackDateCandidate > todayIso() ? todayIso() : fallbackDateCandidate;
    const fallbackCreatedAt = `${fallbackDate}T08:00:00`;
    const createdCandidates = [base.createdAt, activityTimes[0], fallbackCreatedAt].filter(isUsableTimestamp).sort();
    const updatedCandidates = [base.updatedAt, ...activityTimes, fallbackCreatedAt].filter(isUsableTimestamp).sort();
    base.createdAt = createdCandidates[0] || fallbackCreatedAt;
    base.updatedAt = updatedCandidates.at(-1) || base.createdAt;
    return base;
  }

  // Replace or add patients in a page's list, keeping the same array so the
  // page sees the change.
  function applyPatientUpdates(list, updated, removedIds) {
    (updated || []).forEach((patient) => {
      const index = list.findIndex((item) => item.id === patient.id);
      if (index >= 0) list[index] = patient; else list.push(patient);
    });
    (removedIds ? [...removedIds] : []).forEach((id) => {
      const index = list.findIndex((item) => item.id === id);
      if (index >= 0) list.splice(index, 1);
    });
    return list;
  }

  function savePatients(patients) {
    const normalized = patients.map(normalizePatient);
    if (window.AckermanServer?.enabled) {
      // Only patients that changed are sent. The server may hand back a merged or
      // stamped version of a patient; put that version into the page's list.
      let outcome = null;
      try {
        outcome = window.AckermanServer.savePatients(normalized);
      } catch (error) {
        outcome = error.outcome || null;
        console.error("Could not save the patient.", error);
        throw error;
      } finally {
        if (outcome) applyPatientUpdates(patients, [...outcome.replacements.values()], outcome.removals);
      }
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (error) {
      console.warn("Changes could not be saved.", error);
    }
  }

  function isDemoPatient(patient) {
    const id = String(patient?.id || "").trim().toLowerCase();
    const mrn = String(patient?.mrn || "").trim().toUpperCase();
    return id.startsWith("demo-") || mrn.startsWith("DEMO-");
  }

  function removeDemoPatients(patients) {
    return patients.filter((patient) => !isDemoPatient(patient));
  }

  function loadPatients() {
    if (window.AckermanServer?.enabled) {
      try {
        // Demo patients are removed once by the server during the Version 3.3 upgrade.
        return window.AckermanServer.loadPatients().patients;
      } catch (error) {
        console.error("Could not load the shared patient board.", error);
        throw error;
      }
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const normalized = JSON.parse(stored).map(normalizePatient);
        const cleaned = removeDemoPatients(normalized);
        if (cleaned.length !== normalized.length) savePatients(cleaned);
        return cleaned;
      }
      for (const key of LEGACY_STORAGE_KEYS) {
        const legacy = localStorage.getItem(key);
        if (!legacy) continue;
        const migrated = removeDemoPatients(JSON.parse(legacy).map(normalizePatient));
        savePatients(migrated);
        return migrated;
      }
    } catch (error) {
      console.warn("Could not load stored data.", error);
    }
    return [];
  }

  function resetPatients() {
    const patients = [];
    savePatients(patients);
    return patients;
  }

  function normalizedPayments(patient) {
    const base = {
      collectionDate: patient.collectionDate || todayIso(),
      location: patient.location || "Not entered"
    };
    const payments = Array.isArray(patient.payments)
      ? patient.payments.map((payment) => normalizePayment(payment, base)).filter((payment) => payment.amount > EPSILON)
      : [];
    const ledgerTotal = payments.reduce((sum, payment) => sum + transactionEffect(payment), 0);
    const legacyCollected = Math.max(0, Number(patient.collected || 0));
    const missing = legacyCollected - ledgerTotal;
    if (patient.ledgerInitialized !== true && missing > EPSILON) {
      payments.push(normalizePayment({
        id: uid("payment-opening"), amount: missing, type: "Payment",
        date: patient.collectionDate || todayIso(), location: patient.location || "Not entered",
        method: "Previously Collected", note: "Opening amount recorded before detailed payment history.", appliesToPlan: false
      }, base));
    }
    return payments.sort((a, b) => `${a.date}|${a.createdAt}`.localeCompare(`${b.date}|${b.createdAt}`));
  }

  function netCollected(patient) {
    return Math.round(normalizedPayments(patient).reduce((sum, payment) => sum + transactionEffect(payment), 0) * 100) / 100;
  }

  function collectedByParty(patient, party) {
    const normalizedParty = String(party) === "UF" ? "UF" : "Ackerman";
    return Math.round(normalizedPayments(patient)
      .filter((payment) => payment.responsibilityParty === normalizedParty)
      .reduce((sum, payment) => sum + transactionEffect(payment), 0) * 100) / 100;
  }

  function normalizedAdjustments(patient) {
    return Array.isArray(patient.adjustments)
      ? patient.adjustments.map(normalizeAdjustment).filter((entry) => entry.amount > EPSILON)
      : [];
  }

  function adjustmentTotal(patient) {
    return Math.round(normalizedAdjustments(patient).reduce((sum, adjustment) => sum + adjustment.amount, 0) * 100) / 100;
  }

  function ufVerifiedTotal(patient) {
    // Kept as a compatibility alias for older analytics/code. In Version 2.1,
    // UF collections are real ledger entries rather than verification checkboxes.
    return Math.max(0, collectedByParty(patient, "UF"));
  }

  function amountOwed(patient) {
    if (arrangementFromLegacy(patient) === "No Responsibility") return 0;
    return Math.max(0, Math.round((Number(patient.responsibility || 0) - netCollected(patient) - adjustmentTotal(patient)) * 100) / 100);
  }

  function financialBreakdown(patient) {
    const plan = normalizePlan(patient.paymentPlan);
    const accAssigned = plan ? plan.installments.filter((item) => item.responsibilityParty !== "UF").reduce((sum, item) => sum + item.amount, 0) : Number(patient.responsibility || 0);
    const ufAssigned = plan ? plan.installments.filter((item) => item.responsibilityParty === "UF").reduce((sum, item) => sum + item.amount, 0) : 0;
    const totalAssigned = Number(patient.responsibility || 0);
    const accCollected = collectedByParty(patient, "Ackerman");
    const ufCollected = collectedByParty(patient, "UF");
    const totalCollected = accCollected + ufCollected;
    const adjustments = adjustmentTotal(patient);
    const round = (value) => Math.round(Number(value || 0) * 100) / 100;
    return {
      totalAssigned: round(totalAssigned),
      totalCollected: round(totalCollected),
      totalOutstanding: round(totalAssigned - totalCollected - adjustments),
      accAssigned: round(accAssigned),
      accCollected: round(accCollected),
      accOutstanding: round(accAssigned - accCollected),
      ufAssigned: round(ufAssigned),
      ufCollected: round(ufCollected),
      ufOutstanding: round(ufAssigned - ufCollected),
      scheduleAssigned: round(accAssigned + ufAssigned),
      scheduleDelta: round((accAssigned + ufAssigned) - totalAssigned),
      collectionDelta: round(totalCollected - totalAssigned),
      adjustments: round(adjustments)
    };
  }

  function syncFinancials(patient) {
    patient.collected = netCollected(patient);
    return patient;
  }

  function addActivity(patient, entry) {
    patient.activity = Array.isArray(patient.activity) ? patient.activity : [];
    const activity = normalizeActivity({ ...entry, createdAt: entry.createdAt || new Date().toISOString() });
    patient.activity.push(activity);
    patient.activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    patient.createdAt = patient.createdAt || activity.createdAt;
    patient.updatedAt = activity.createdAt;
    return activity;
  }

  function addPaymentTransaction(patient, payment, activity = true) {
    patient.payments = Array.isArray(patient.payments) ? patient.payments : [];
    const transaction = normalizePayment({ ...payment, createdAt: payment.createdAt || new Date().toISOString() }, patient);
    patient.payments.push(transaction);
    syncFinancials(patient);
    if (activity) addActivity(patient, {
      type: "payment",
      title: paymentTitle(transaction),
      detail: `${currency.format(transaction.amount)} · ${transaction.method}${transaction.note ? ` · ${transaction.note}` : ""}`,
      date: transaction.date
    });
    return transaction;
  }

  function addAdjustment(patient, adjustment, activity = true) {
    patient.adjustments = Array.isArray(patient.adjustments) ? patient.adjustments : [];
    const normalized = normalizeAdjustment({ ...adjustment, createdAt: adjustment.createdAt || new Date().toISOString() });
    patient.adjustments.push(normalized);
    if (activity) addActivity(patient, {
      type: "adjustment",
      title: `${normalized.type} recorded`,
      detail: `${currency.format(normalized.amount)}${normalized.note ? ` · ${normalized.note}` : ""}`,
      date: normalized.date
    });
    return normalized;
  }

  function reversibleAmount(patient, transactionId) {
    const ledger = normalizedPayments(patient);
    const original = ledger.find((transaction) => transaction.id === transactionId);
    if (!original || transactionEffect(original) <= 0) return 0;
    const reversed = ledger
      .filter((transaction) => transaction.relatedTransactionId === transactionId && transactionEffect(transaction) < 0)
      .reduce((sum, transaction) => sum + transaction.amount, 0);
    return Math.max(0, Math.round((original.amount - reversed) * 100) / 100);
  }

  function planPaymentEvents(patient) {
    if (!patient.paymentPlan) return [];
    const flagged = normalizedPayments(patient).filter((payment) => payment.appliesToPlan || payment.installmentId);
    const flaggedNet = flagged.reduce((sum, payment) => sum + transactionEffect(payment), 0);
    const inferredPlanPaid = Math.max(0, netCollected(patient) - Number(patient.paymentPlan.openingCollected || 0));
    const missing = inferredPlanPaid - flaggedNet;
    if (missing > EPSILON) {
      flagged.push(normalizePayment({
        id: uid("payment-plan-opening"),
        type: "Payment",
        amount: missing,
        date: patient.collectionDate || patient.paymentPlan.createdDate || todayIso(),
        location: patient.location || "Not entered",
        officeSite: patient.location || "Not entered",
        username: "Migrated record",
        responsibilityParty: "Ackerman",
        method: "Previously Collected",
        note: "Plan amount recorded before installment tracking was enabled.",
        appliesToPlan: true
      }, patient));
    }
    return flagged.sort((a, b) => `${a.date}|${a.createdAt}`.localeCompare(`${b.date}|${b.createdAt}`));
  }

  function planSummary(patient) {
    const plan = normalizePlan(patient.paymentPlan);
    if (!plan) return null;

    const installments = plan.installments.map((installment, index) => ({
      ...installment,
      number: index + 1,
      paidAmount: 0,
      remaining: installment.amount,
      amountDue: installment.amount,
      variance: -installment.amount,
      allocations: [],
      paidDate: "",
      status: installment.responsibilityParty === "UF" ? "UF Pending" : "Upcoming",
      onTime: false,
      daysLate: 0,
      ufCheckDue: false
    }));
    const byId = new Map(installments.map((item) => [item.id, item]));
    const events = planPaymentEvents({ ...patient, paymentPlan: plan });
    const unlinkedByParty = { Ackerman: [], UF: [] };

    events.forEach((payment) => {
      const effect = transactionEffect(payment);
      const linked = payment.installmentId ? byId.get(payment.installmentId) : null;
      if (linked) {
        linked.paidAmount += effect;
        linked.allocations.push({ amount: effect, date: payment.date, paymentId: payment.id, type: payment.type });
      } else if (Math.abs(effect) > EPSILON) {
        unlinkedByParty[payment.responsibilityParty === "UF" ? "UF" : "Ackerman"].push({ payment, effect });
      }
    });

    // Legacy transactions without a scheduled-payment link are allocated oldest
    // first within their assigned party. New Version 2.1 payments are always linked.
    ["Ackerman", "UF"].forEach((party) => {
      const partyInstallments = installments.filter((item) => item.responsibilityParty === party);
      unlinkedByParty[party].forEach(({ payment, effect: rawEffect }) => {
        let effect = rawEffect;
        if (effect > EPSILON) {
          for (const installment of partyInstallments) {
            if (effect <= EPSILON) break;
            const needed = Math.max(0, installment.amount - Math.max(0, installment.paidAmount));
            if (needed <= EPSILON) continue;
            const allocated = Math.min(needed, effect);
            installment.paidAmount += allocated;
            installment.allocations.push({ amount: allocated, date: payment.date, paymentId: payment.id, type: payment.type });
            effect -= allocated;
          }
          if (effect > EPSILON && partyInstallments.length) {
            const last = partyInstallments.at(-1);
            last.paidAmount += effect;
            last.allocations.push({ amount: effect, date: payment.date, paymentId: payment.id, type: payment.type });
          }
        } else if (effect < -EPSILON) {
          let debit = Math.abs(effect);
          for (let index = partyInstallments.length - 1; index >= 0 && debit > EPSILON; index -= 1) {
            const installment = partyInstallments[index];
            const available = Math.max(0, installment.paidAmount);
            if (available <= EPSILON) continue;
            const removed = Math.min(available, debit);
            installment.paidAmount -= removed;
            installment.allocations.push({ amount: -removed, date: payment.date, paymentId: payment.id, type: payment.type });
            debit -= removed;
          }
        }
      });
    });

    const today = todayIso();
    installments.forEach((installment) => {
      installment.paidAmount = Math.round(installment.paidAmount * 100) / 100;
      installment.remaining = Math.round((installment.amount - installment.paidAmount) * 100) / 100;
      installment.amountDue = Math.max(0, installment.remaining);
      installment.variance = Math.round((installment.paidAmount - installment.amount) * 100) / 100;
      const positiveAllocations = installment.allocations.filter((allocation) => allocation.amount > EPSILON);
      installment.paidDate = positiveAllocations.length ? positiveAllocations.map((allocation) => allocation.date).sort().at(-1) : "";

      if (installment.responsibilityParty === "UF") {
        const hasRecordedUfPayment = installment.paidAmount > EPSILON;
        installment.ufCheckDue = !hasRecordedUfPayment && installment.dueDate < today;
        installment.daysLate = installment.ufCheckDue ? Math.max(0, daysBetween(installment.dueDate, today)) : 0;
        if (installment.amountDue <= EPSILON) installment.status = "Paid";
        else if (hasRecordedUfPayment) installment.status = "UF Payment Recorded";
        else if (installment.ufCheckDue) installment.status = "UF Check Due";
        else installment.status = "UF Pending";
        return;
      }

      if (installment.amountDue <= EPSILON) {
        installment.status = "Paid";
        installment.onTime = Boolean(installment.paidDate && installment.paidDate <= installment.dueDate);
        installment.daysLate = installment.paidDate ? Math.max(0, daysBetween(installment.dueDate, installment.paidDate)) : 0;
      } else if (installment.dueDate === today) {
        installment.status = "Due Today";
      } else if (installment.dueDate < today) {
        installment.status = "Overdue";
        installment.daysLate = Math.max(0, daysBetween(installment.dueDate, today));
      } else {
        installment.status = "Upcoming";
      }
    });

    const ackerman = installments.filter((installment) => installment.responsibilityParty === "Ackerman");
    const uf = installments.filter((installment) => installment.responsibilityParty === "UF");
    const total = installments.reduce((sum, installment) => sum + installment.amount, 0);
    const completed = installments.filter((installment) => installment.amountDue <= EPSILON);
    const due = ackerman.filter((installment) => installment.dueDate <= today);
    const onTime = due.filter((installment) => installment.status === "Paid" && installment.onTime);
    const overdue = ackerman.filter((installment) => installment.status === "Overdue");
    const dueToday = ackerman.filter((installment) => installment.status === "Due Today");
    const ufChecksDue = uf.filter((installment) => installment.ufCheckDue);
    const oldestUfCheck = ufChecksDue.length ? ufChecksDue.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] : null;
    const oldestUfCheckDays = oldestUfCheck ? Math.max(1, daysBetween(oldestUfCheck.dueDate, today)) : 0;
    const nextDue = installments.find((installment) => installment.amountDue > EPSILON) || null;
    const nextAckermanDue = ackerman.find((installment) => installment.amountDue > EPSILON) || null;
    const scheduledToDate = due.reduce((sum, installment) => sum + installment.amount, 0);
    const overdueAmount = overdue.reduce((sum, installment) => sum + installment.amountDue, 0);
    const dueTodayAmount = dueToday.reduce((sum, installment) => sum + installment.amountDue, 0);
    const financials = financialBreakdown(patient);
    const accountResponsibility = Math.max(0, Number(patient.responsibility || 0));
    const totalOwed = amountOwed(patient);
    const remainingPercent = accountResponsibility > EPSILON ? Math.max(0, Math.min(100, (totalOwed / accountResponsibility) * 100)) : 0;
    const progressPercent = accountResponsibility > EPSILON ? Math.max(0, Math.min(100, (Math.max(0, financials.totalCollected) / accountResponsibility) * 100)) : 0;
    const health = overdue.length >= 2 ? "red" : (overdue.length === 1 ? "yellow" : "green");
    const attention = overdue.length >= 2
      ? "2+ Payments Overdue"
      : (overdue.length === 1
        ? "1 Payment Overdue"
        : (ufChecksDue.length > 0
          ? "UF Check Due"
          : (dueToday.length > 0 ? "Due Today" : (nextDue ? "On Track" : "Complete"))));

    return {
      plan, installments,
      total: Math.round(total * 100) / 100,
      paid: Math.round(financials.totalCollected * 100) / 100,
      remaining: Math.max(0, Math.round(totalOwed * 100) / 100),
      completedCount: completed.length, totalCount: installments.length,
      ackermanCount: ackerman.length, ufCount: uf.length, dueCount: due.length, onTimeCount: onTime.length,
      overdueCount: overdue.length, dueTodayCount: dueToday.length, ufCheckDueCount: ufChecksDue.length,
      oldestUfCheckDate: oldestUfCheck?.dueDate || "", oldestUfCheckDays,
      overdueAmount: Math.round(overdueAmount * 100) / 100, dueTodayAmount: Math.round(dueTodayAmount * 100) / 100,
      ufVerifiedAmount: Math.max(0, financials.ufCollected),
      ackermanTotal: financials.accAssigned, ackermanPaid: financials.accCollected,
      ackermanOutstanding: financials.accOutstanding, ackermanOwed: Math.max(0, financials.accOutstanding),
      ufTotal: financials.ufAssigned, ufPaid: financials.ufCollected,
      ufOutstanding: financials.ufOutstanding, ufOwed: Math.max(0, financials.ufOutstanding),
      totalCollected: financials.totalCollected, totalOutstanding: financials.totalOutstanding,
      totalOwed: Math.round(totalOwed * 100) / 100, scheduleOwed: Math.max(0, Math.round((total - financials.totalCollected) * 100) / 100),
      remainingPercent, nextDue, nextAckermanDue, attention, health, progressPercent,
      onTimeRate: due.length > 0 ? (onTime.length / due.length) * 100 : null,
      scheduledToDate: Math.round(scheduledToDate * 100) / 100,
      scheduleVariance: Math.round((financials.accCollected - scheduledToDate) * 100) / 100,
      unallocatedPayment: 0, promiseToPayDate: "", renegotiationCount: plan.renegotiationCount, repeatedMisses: overdue.length >= 2
    };
  }

  function effectiveStatus(patient) {
    const arrangement = arrangementFromLegacy(patient);
    const owed = amountOwed(patient);
    if (arrangement === "No Responsibility" || Number(patient.responsibility || 0) <= 0) return "No Responsibility";
    if (owed <= EPSILON) return "Paid in Full";
    if (arrangement === "Payment Plan" && patient.paymentPlan) return "Payment Plan";
    if (netCollected(patient) > EPSILON) return "Partially Paid";
    const today = todayIso();
    if (patient.collectionDate < today) return "Overdue";
    if (patient.collectionDate === today) return "Due Today";
    return "Upcoming Collection";
  }

  function attentionStatus(patient) {
    const status = effectiveStatus(patient);
    if (status === "Payment Plan") return planSummary(patient)?.attention || "On Track";
    if (status === "Partially Paid") {
      const dueDate = String(patient.collectionDate || "");
      if (!dueDate) return "Upcoming";
      const today = todayIso();
      if (dueDate < today) return "Overdue";
      if (dueDate === today) return "Due Today";
      return "Upcoming";
    }
    return status;
  }

  function nextActionDate(patient) {
    if (effectiveStatus(patient) === "Payment Plan") {
      return planSummary(patient)?.nextDue?.dueDate || patient.collectionDate || "";
    }
    return patient.collectionDate || "";
  }

  function patientHealth(patient) {
    const status = effectiveStatus(patient);
    if (status === "Payment Plan") {
      const summary = planSummary(patient);
      const level = summary?.health || "green";
      return {
        level,
        row: `health-${level}`,
        pill: `health-${level}`,
        overdueCount: summary?.overdueCount || 0,
        ufCheckDueCount: summary?.ufCheckDueCount || 0
      };
    }
    const isOverdue = attentionStatus(patient) === "Overdue";
    const level = isOverdue ? "yellow" : "green";
    return { level, row: `health-${level}`, pill: `health-${level}`, overdueCount: isOverdue ? 1 : 0, ufCheckDueCount: 0 };
  }

  function statusMeta(status) {
    const map = {
      "Upcoming Collection": { row: "health-green", pill: "health-green", short: "Upcoming" },
      "Ready for Collection": { row: "health-green", pill: "health-green", short: "Upcoming" },
      "Due Today": { row: "health-green", pill: "health-green", short: "Due Today" },
      Overdue: { row: "health-yellow", pill: "health-yellow", short: "Overdue" },
      "Partially Paid": { row: "health-green", pill: "health-green", short: "Partial" },
      "Payment Plan": { row: "health-green", pill: "health-green", short: "Plan" },
      "Paid in Full": { row: "health-green", pill: "health-green", short: "Paid" },
      "No Responsibility": { row: "health-green", pill: "health-green", short: "No Responsibility" },
      "On Track": { row: "health-green", pill: "health-green", short: "On Track" },
      "1 Payment Overdue": { row: "health-yellow", pill: "health-yellow", short: "1 Overdue" },
      "2+ Payments Overdue": { row: "health-red", pill: "health-red", short: "2+ Overdue" },
      "UF Check Due": { row: "health-green", pill: "uf-flag", short: "UF Check Due" },
      Complete: { row: "health-green", pill: "health-green", short: "Complete" },
      "UF Pending": { row: "health-green", pill: "uf-pending", short: "UF Pending" },
      "UF Payment Recorded": { row: "health-green", pill: "health-green", short: "UF Recorded" }
    };
    return map[status] || map["Upcoming Collection"];
  }

  function loadSavedViews(page) {
    try {
      let raw = localStorage.getItem(SAVED_VIEWS_KEY);
      if (!raw) {
        for (const legacyKey of LEGACY_SAVED_VIEWS_KEYS) {
          raw = localStorage.getItem(legacyKey);
          if (raw) {
            localStorage.setItem(SAVED_VIEWS_KEY, raw);
            break;
          }
        }
      }
      const all = JSON.parse(raw || "{}");
      return Array.isArray(all[page]) ? all[page] : [];
    } catch (error) {
      console.warn("Could not load saved views.", error);
      return [];
    }
  }

  function saveSavedView(page, view) {
    const all = (() => {
      try { return JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) || "{}"); }
      catch { return {}; }
    })();
    const views = Array.isArray(all[page]) ? all[page] : [];
    const record = { id: String(view.id || uid("view")), name: String(view.name || "Saved View"), settings: view.settings || {} };
    const index = views.findIndex((item) => item.id === record.id);
    if (index >= 0) views[index] = record; else views.push(record);
    all[page] = views.sort((a, b) => a.name.localeCompare(b.name));
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(all));
    return record;
  }

  function deleteSavedView(page, id) {
    const all = (() => {
      try { return JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) || "{}"); }
      catch { return {}; }
    })();
    all[page] = (Array.isArray(all[page]) ? all[page] : []).filter((item) => item.id !== id);
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(all));
  }

  function formatDate(isoDate) {
    const date = parseIsoDate(isoDate);
    if (!date) return isoDate || "-";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "-";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function formatMonth(monthKey) {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
    const [year, month] = monthKey.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(year, month - 1, 1));
  }

  function formatFileSize(bytes) {
    const value = Math.max(0, Number(bytes || 0));
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function printPatientSummary(patient, documents = []) {
    const status = effectiveStatus(patient);
    const plan = planSummary(patient);
    const payments = normalizedPayments(patient).slice().sort((a, b) => `${a.date}|${a.createdAt}`.localeCompare(`${b.date}|${b.createdAt}`));
    const adjustments = normalizedAdjustments(patient).slice().sort((a, b) => `${a.date}|${a.createdAt}`.localeCompare(`${b.date}|${b.createdAt}`));
    const activities = (patient.activity || []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const safeDocuments = Array.isArray(documents) ? documents : [];

    const tableRows = (rows, emptyText) => rows.length ? rows.join("") : `<tr><td colspan="99" class="empty">${escapeHtml(emptyText)}</td></tr>`;
    const statusText = plan ? `${status} - ${plan.attention}` : status;
    const generatedAt = formatDateTime(new Date().toISOString());

    const paymentRows = tableRows(payments.map((payment) => {
      const effect = transactionEffect(payment);
      return `<tr><td>${escapeHtml(formatDate(payment.date))}</td><td>${escapeHtml(payment.type)}</td><td>${payment.responsibilityParty === "UF" ? "UF" : "ACC"}</td><td class="num">${escapeHtml(currency.format(effect))}</td><td>${escapeHtml(payment.username || "-")}</td><td>${escapeHtml(payment.officeSite || payment.location || "-")}</td><td>${escapeHtml(payment.method)}</td><td>${escapeHtml(payment.note || "-")}</td></tr>`;
    }), "No payment transactions recorded.");

    const adjustmentRows = tableRows(adjustments.map((entry) => `<tr><td>${escapeHtml(formatDate(entry.date))}</td><td>${escapeHtml(entry.type)}</td><td class="num">${escapeHtml(currency.format(entry.amount))}</td><td>${escapeHtml(entry.note || "-")}</td></tr>`), "No adjustments recorded.");


    const planSection = plan ? `
      <section>
        <h2>Payment Plan</h2>
        <div class="metrics">
          <div><span>Total patient responsibility</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).totalAssigned))}</strong></div>
          <div><span>Collected total</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).totalCollected))}</strong></div>
          <div><span>Outstanding total</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).totalOutstanding))}</strong></div>
          <div><span>ACC assigned</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).accAssigned))}</strong></div>
          <div><span>ACC collected</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).accCollected))}</strong></div>
          <div><span>ACC outstanding</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).accOutstanding))}</strong></div>
          <div><span>UF assigned</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).ufAssigned))}</strong></div>
          <div><span>UF collected</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).ufCollected))}</strong></div>
          <div><span>UF outstanding</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).ufOutstanding))}</strong></div>
          <div><span>Plan progress</span><strong>${plan.progressPercent.toFixed(1)}%</strong></div>
          <div><span>On-time rate</span><strong>${plan.onTimeRate === null ? "Not measured" : `${plan.onTimeRate.toFixed(1)}%`}</strong></div>
          <div><span>UF checks due</span><strong>${plan.ufCheckDueCount}</strong></div>
        </div>
        <table><thead><tr><th>#</th><th>Due date</th><th>Assigned to</th><th>Assigned amount</th><th>Collected</th><th>Outstanding</th><th>Result</th></tr></thead><tbody>
          ${plan.installments.map((item) => `<tr><td>${item.number}</td><td>${escapeHtml(formatDate(item.dueDate))}</td><td>${item.responsibilityParty === "UF" ? "UF" : "ACC"}</td><td class="num">${escapeHtml(currency.format(item.amount))}</td><td class="num">${escapeHtml(currency.format(item.paidAmount))}</td><td class="num">${escapeHtml(currency.format(item.remaining))}</td><td>${escapeHtml(item.status)}</td></tr>`).join("")}
        </tbody></table>
      </section>` : "";

    const documentRows = tableRows(safeDocuments.map((document) => `<tr><td>${escapeHtml(document.name || "Document")}</td><td>${escapeHtml(document.type || "-")}</td><td>${escapeHtml(formatFileSize(document.size || 0))}</td><td>${escapeHtml(formatDateTime(document.addedAt || ""))}</td></tr>`), "No documents attached in this browser.");

    const activityRows = activities.length
      ? activities.map((activity) => `<li><strong>${escapeHtml(activity.title)}</strong><span>${escapeHtml(formatDateTime(activity.createdAt))} - ${escapeHtml(activity.actor)}</span><p>${escapeHtml(activity.detail || "No additional detail.")}</p></li>`).join("")
      : `<li class="empty">No activity recorded.</li>`;

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(patient.name)} Account Summary</title>
<style>
  @page { size: letter; margin: 0.55in; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #172b3a; font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.35; }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 3px solid #087f8c; padding-bottom: 12px; margin-bottom: 16px; }
  h1 { margin: 0 0 4px; color: #12324a; font-size: 21pt; }
  h2 { margin: 18px 0 8px; color: #12324a; font-size: 13pt; border-bottom: 1px solid #cfd9e0; padding-bottom: 4px; }
  p { margin: 4px 0; }
  .prototype { border: 1px solid #c78600; background: #fff8e7; padding: 7px 9px; font-weight: 700; color: #5d4300; }
  .meta { text-align: right; font-size: 9pt; color: #51616d; }
  .identity, .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .identity div, .metrics div { border: 1px solid #d9e1e7; border-radius: 5px; padding: 7px; min-width: 0; }
  .identity span, .metrics span { display: block; color: #5f6f7b; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  .identity strong, .metrics strong { display: block; margin-top: 2px; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 8.5pt; page-break-inside: auto; }
  tr { page-break-inside: avoid; page-break-after: auto; }
  th, td { border: 1px solid #cfd9e0; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { background: #eef4f7; color: #243c4c; }
  .num { text-align: right; white-space: nowrap; }
  .note { border: 1px solid #d9e1e7; background: #f7fafb; padding: 9px; white-space: pre-wrap; }
  .empty { color: #6a7780; font-style: italic; text-align: center; }
  .activity { margin: 0; padding-left: 20px; }
  .activity li { margin: 0 0 8px; padding-left: 3px; }
  .activity span { display: block; color: #5f6f7b; font-size: 8.5pt; }
  .activity p { margin: 2px 0 0; }
  footer { margin-top: 18px; border-top: 1px solid #cfd9e0; padding-top: 7px; color: #687680; font-size: 8pt; }
  @media print { .no-print { display: none !important; } }
</style></head><body>
<header><div><h1>Patient Account Summary</h1><p><strong>${escapeHtml(patient.name)}</strong> - ${escapeHtml(patient.mrn)}</p><div class="prototype">INTERNAL USE ONLY</div></div><div class="meta"><strong>Ackerman Patient Payment Board</strong><br>Generated ${escapeHtml(generatedAt)}<br>Last updated ${escapeHtml(formatDateTime(patient.updatedAt || patient.createdAt))}</div></header>
<section><h2>Account Overview</h2><div class="identity">
  <div><span>Status</span><strong>${escapeHtml(statusText)}</strong></div>
  <div><span>Arrangement</span><strong>${escapeHtml(arrangementFromLegacy(patient))}</strong></div>
  <div><span>Treatment site</span><strong>${escapeHtml(patient.location)}</strong></div>
  <div><span>Status note</span><strong>${escapeHtml(patient.statusNote || "-")}</strong></div>
  <div><span>Treatment type</span><strong>${escapeHtml(treatmentLabel(patient))}</strong></div>
  <div><span>Insurance</span><strong>${escapeHtml(patient.insurance)}</strong></div>
  <div><span>Collection date</span><strong>${escapeHtml(formatDate(patient.collectionDate))}</strong></div>
  <div><span>${patient.archived ? "Completed" : "Next action"}</span><strong>${escapeHtml(formatDate(patient.archived ? patient.completedAt : nextActionDate(patient)))}</strong></div>
  ${patient.archived ? `<div><span>Completion reason</span><strong>${escapeHtml(patient.completionReason || "-")}</strong></div>` : ""}
  ${patient.archived && patient.completionNote ? `<div><span>Completion note</span><strong>${escapeHtml(patient.completionNote)}</strong></div>` : ""}
  <div><span>Created</span><strong>${escapeHtml(formatDateTime(patient.createdAt))}</strong></div>
  <div><span>Last updated</span><strong>${escapeHtml(formatDateTime(patient.updatedAt))}</strong></div>
</div></section>
<section><h2>Financial Summary</h2><div class="metrics">
  <div><span>Total patient responsibility</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).totalAssigned))}</strong></div>
  <div><span>Collected total responsibility</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).totalCollected))}</strong></div>
  <div><span>Outstanding total responsibility</span><strong>${escapeHtml(currency.format(financialBreakdown(patient).totalOutstanding))}</strong></div>
  <div><span>Adjustments</span><strong>${escapeHtml(currency.format(adjustmentTotal(patient)))}</strong></div>
</div></section>
${planSection}
<section><h2>Finance Note</h2><div class="note">${escapeHtml(patient.notes || "No finance note entered.")}${patient.noResponsibilityReason ? `\n\nNo-responsibility reason: ${escapeHtml(patient.noResponsibilityReason)}` : ""}</div></section>
<section><h2>Payment Ledger</h2><table><thead><tr><th>Date</th><th>Type</th><th>Assigned</th><th>Net amount</th><th>Username</th><th>Office site</th><th>Method</th><th>Note</th></tr></thead><tbody>${paymentRows}</tbody></table></section>
<section><h2>Adjustments</h2><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reason</th></tr></thead><tbody>${adjustmentRows}</tbody></table></section>
<section><h2>Attached Document Index</h2><table><thead><tr><th>Document</th><th>Type</th><th>Size</th><th>Attached</th></tr></thead><tbody>${documentRows}</tbody></table></section>
<section><h2>Activity Timeline</h2><ol class="activity">${activityRows}</ol></section>
<footer>This summary is generated from the Ackerman Patient Payment Board for authorized internal use.</footer>
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},250);});<\/script>
</body></html>`;

    const printWindow = window.open("", "_blank");
    if (!printWindow) return false;
    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    return true;
  }

  window.AckermanData = {
    STORAGE_KEY,
    LEGACY_STORAGE_KEYS,
    SAVED_VIEWS_KEY,
    EPSILON,
    TREATMENT_FLAGS,
    OFFICE_SITES,
    currency,
    todayIso,
    toIsoLocal,
    dateOffset,
    addDays,
    addMonths,
    daysBetween,
    deepCopy,
    uid,
    splitAmount,
    makePlanSchedule,
    seedPatients,
    normalizePatient,
    loadPatients,
    savePatients,
    applyPatientUpdates,
    resetPatients,
    arrangementFromLegacy,
    normalizeTreatmentType,
    normalizeTreatments,
    patientTreatments,
    treatmentLabel,
    transactionEffect,
    normalizedPayments,
    netCollected,
    collectedByParty,
    financialBreakdown,
    normalizedAdjustments,
    adjustmentTotal,
    ufVerifiedTotal,
    amountOwed,
    syncFinancials,
    addActivity,
    addPaymentTransaction,
    addAdjustment,
    reversibleAmount,
    planPaymentEvents,
    planSummary,
    effectiveStatus,
    attentionStatus,
    nextActionDate,
    patientHealth,
    statusMeta,
    loadSavedViews,
    saveSavedView,
    deleteSavedView,
    formatDate,
    formatDateTime,
    formatMonth,
    formatFileSize,
    escapeHtml,
    printPatientSummary
  };
  window.AckermanServer?.useNormalizer?.(normalizePatient);
})();
