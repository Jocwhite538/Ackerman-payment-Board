(function () {
  "use strict";

  const D = window.AckermanData;
  const Docs = window.AckermanDocuments;
  if (!D) throw new Error("AckermanData failed to load.");

  let patients = D.loadPatients();
  let sortState = { key: "completedAt", direction: "desc" };
  let detailsPatientId = null;

  const elements = {
    tbody: document.getElementById("completedTableBody"),
    table: document.querySelector(".completed-table"),
    empty: document.getElementById("completedEmptyState"),
    search: document.getElementById("completedSearch"),
    fromDate: document.getElementById("completedFromDate"),
    toDate: document.getElementById("completedToDate"),
    location: document.getElementById("completedLocationFilter"),
    treatment: document.getElementById("completedTreatmentFilter"),
    status: document.getElementById("completedStatusFilter"),
    sort: document.getElementById("completedSortSelect"),
    resultCount: document.getElementById("completedResultCount"),
    savedViewSelect: document.getElementById("completedSavedViewSelect"),
    savedViewName: document.getElementById("completedSavedViewName"),
    detailsDialog: document.getElementById("completedDetailsDialog"),
    toastRegion: document.getElementById("toastRegion")
  };

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function setSelectOptions(select, values, allLabel) {
    const previous = select.value;
    select.innerHTML = `<option value="all">${D.escapeHtml(allLabel)}</option>`;
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    select.value = values.includes(previous) ? previous : "all";
  }

  function populateFilters() {
    const completed = patients.filter((patient) => patient.archived);
    const locations = [...new Set(completed.map((patient) => patient.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const treatments = [...new Set(completed.flatMap((patient) => D.patientTreatments(patient)))].sort((a, b) => a.localeCompare(b));
    setSelectOptions(elements.location, locations, "All sites");
    setSelectOptions(elements.treatment, treatments, "All treatments");
  }

  function parseSort(value) {
    const [key, direction] = value.split(":");
    return { key, direction: direction === "asc" ? "asc" : "desc" };
  }

  function sortValue(patient, key) {
    if (key === "daysToComplete") return D.daysBetween(patient.collectionDate, patient.completedAt);
    if (key === "planProgress") return D.planSummary(patient)?.onTimeRate ?? -1;
    if (key === "collected") return D.netCollected(patient);
    if (key === "responsibility") return Number(patient.responsibility || 0);
    return String(patient[key] || "").toLowerCase();
  }

  function comparePatients(a, b) {
    const aValue = sortValue(a, sortState.key);
    const bValue = sortValue(b, sortState.key);
    let result;
    if (typeof aValue === "number" && typeof bValue === "number") result = aValue - bValue;
    else result = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: "base" });
    if (result === 0) result = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return sortState.direction === "desc" ? -result : result;
  }

  function matchesCompletionType(patient) {
    const filter = elements.status.value;
    if (filter === "all") return true;
    if (filter === "Payment Plan") return Boolean(patient.paymentPlan);
    return D.effectiveStatus(patient) === filter;
  }

  function filteredPatients() {
    const query = elements.search.value.trim().toLowerCase();
    const from = elements.fromDate.value;
    const to = elements.toDate.value;
    return patients
      .filter((patient) => {
        if (!patient.archived) return false;
        const searchable = [patient.name, patient.mrn, patient.location, D.treatmentLabel(patient), patient.insurance, patient.statusNote]
          .join(" ").toLowerCase();
        return (!query || searchable.includes(query))
          && (!from || patient.completedAt >= from)
          && (!to || patient.completedAt <= to)
          && (elements.location.value === "all" || patient.location === elements.location.value)
          && (elements.treatment.value === "all" || D.patientTreatments(patient).includes(elements.treatment.value))
          && matchesCompletionType(patient);
      })
      .sort(comparePatients);
  }

  function planPerformanceHtml(patient) {
    const plan = D.planSummary(patient);
    if (!plan) return '<div class="cell-secondary">Not a payment plan</div>';
    const onTime = plan.onTimeRate === null ? "Not measured" : `${plan.onTimeRate.toFixed(0)}% on time`;
    return `
      <div class="cell-primary">${plan.completedCount} of ${plan.totalCount} installments paid</div>
      <div class="progress-track compact-progress"><div class="progress-fill health-progress" style="width:${plan.progressPercent.toFixed(2)}%"></div></div>
      <div class="cell-secondary">${D.escapeHtml(onTime)}</div>
    `;
  }

  function actionButtons(patient) {
    return `
      <button class="btn btn-ghost btn-small" type="button" data-action="details" data-id="${D.escapeHtml(patient.id)}">Details</button>
      <button class="btn btn-secondary btn-small" type="button" data-action="restore" data-id="${D.escapeHtml(patient.id)}">Restore</button>
      <button class="btn btn-documents btn-small" type="button" data-action="documents" data-id="${D.escapeHtml(patient.id)}">Docs<span class="doc-count" data-doc-count-for="${D.escapeHtml(patient.id)}" hidden></span></button>
    `;
  }

  function renderRows() {
    const rows = filteredPatients();
    elements.tbody.innerHTML = "";
    elements.empty.hidden = rows.length > 0;
    elements.table.hidden = rows.length === 0;

    rows.forEach((patient) => {
      const status = D.effectiveStatus(patient);
      const health = D.patientHealth(patient);
      const days = D.daysBetween(patient.collectionDate, patient.completedAt);
      const tr = document.createElement("tr");
      tr.className = health.row;
      tr.innerHTML = `
        <td data-label="Completed">
          <div class="date-main">${D.formatDate(patient.completedAt)}</div>
          <div class="date-relative">${days === 0 ? "Same day" : `${Math.max(0, days)} days from collection date`}</div>
          <div class="cell-secondary completion-reason-inline">${D.escapeHtml(patient.completionReason || "Completion reason not recorded")}</div>
        </td>
        <td data-label="Patient">
          <div class="patient-name">${D.escapeHtml(patient.name)}</div>
          <div class="mrn">${D.escapeHtml(patient.mrn)}</div>
          <div class="cell-tertiary">Updated ${D.escapeHtml(D.formatDateTime(patient.updatedAt || patient.createdAt))}</div>
          <div class="status-stack inline-status"><span class="status-pill ${health.pill}">${D.escapeHtml(status)}</span></div>
          ${patient.statusNote ? `<div class="status-note-readonly">${D.escapeHtml(patient.statusNote)}</div>` : ""}
        </td>
        <td data-label="Treatment">
          <div class="treatment-badges">${D.patientTreatments(patient).map((treatment) => `<span class="treatment-badge">${D.escapeHtml(treatment)}</span>`).join("")}</div>
        </td>
        <td data-label="Site & Insurance">
          <div class="cell-primary">${D.escapeHtml(patient.location)}</div>
          <div class="cell-secondary">${D.escapeHtml(patient.insurance)}</div>
        </td>
        <td data-label="Financial Result">
          <div class="financial-stack">
            <div class="financial-line"><span>Responsibility</span><strong>${D.currency.format(patient.responsibility)}</strong></div>
            <div class="financial-line"><span>Collected</span><strong>${D.currency.format(D.netCollected(patient))}</strong></div>
            <div class="financial-line"><span>Adjustments</span><strong>${D.currency.format(D.adjustmentTotal(patient))}</strong></div>
            <div class="financial-line balance"><span>Balance</span><strong>${D.currency.format(D.amountOwed(patient))}</strong></div>
          </div>
        </td>
        <td data-label="Plan Performance">${planPerformanceHtml(patient)}</td>
        <td class="actions-cell" data-label="Actions"><div class="actions">${actionButtons(patient)}</div></td>
      `;
      elements.tbody.appendChild(tr);
    });

    elements.resultCount.textContent = `${rows.length} ${rows.length === 1 ? "record" : "records"}`;
    updateDocumentCounts(rows);
  }

  async function updateDocumentCounts(rows) {
    if (!Docs) return;
    await Promise.all(rows.map(async (patient) => {
      try {
        const value = await Docs.count(patient.id);
        document.querySelectorAll(`[data-doc-count-for="${CSS.escape(patient.id)}"]`).forEach((badge) => {
          badge.textContent = value;
          badge.hidden = value === 0;
        });
      } catch (error) {
        console.warn(error);
      }
    }));
  }

  function renderSummary() {
    const completed = patients.filter((patient) => patient.archived);
    const today = D.todayIso();
    const month = today.slice(0, 7);
    const todayRows = completed.filter((patient) => patient.completedAt === today);
    const monthRows = completed.filter((patient) => patient.completedAt.slice(0, 7) === month);
    const plans = completed.filter((patient) => patient.paymentPlan);
    const planSummaries = plans.map(D.planSummary).filter(Boolean);
    const dueInstallments = planSummaries.reduce((sum, plan) => sum + plan.dueCount, 0);
    const onTimeInstallments = planSummaries.reduce((sum, plan) => sum + plan.onTimeCount, 0);
    const onTimeRate = dueInstallments > 0 ? (onTimeInstallments / dueInstallments) * 100 : 0;

    document.getElementById("completedCount").textContent = completed.length.toLocaleString();
    document.getElementById("completedToday").textContent = todayRows.length.toLocaleString();
    document.getElementById("completedTodayAmount").textContent = `${D.currency.format(todayRows.reduce((sum, patient) => sum + D.netCollected(patient), 0))} collected`;
    document.getElementById("completedMonth").textContent = monthRows.length.toLocaleString();
    document.getElementById("completedMonthAmount").textContent = `${D.currency.format(monthRows.reduce((sum, patient) => sum + D.netCollected(patient), 0))} collected`;
    document.getElementById("completedCollected").textContent = D.currency.format(completed.reduce((sum, patient) => sum + D.netCollected(patient), 0));
    document.getElementById("completedPlans").textContent = plans.length.toLocaleString();
    document.getElementById("completedPlanRate").textContent = `${onTimeRate.toFixed(1)}% on-time installment rate`;
  }

  function updateSortIndicators() {
    document.querySelectorAll(".sort-button").forEach((button) => {
      const active = button.dataset.sortKey === sortState.key;
      button.querySelector(".sort-indicator").textContent = active ? (sortState.direction === "asc" ? "▲" : "▼") : "";
    });
  }

  function render() {
    renderRows();
    renderSummary();
    updateSortIndicators();
    const refreshed = document.getElementById("completedRefreshedAt");
    if (refreshed) refreshed.textContent = `Browser data refreshed ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`;
  }

  function paymentHistoryHtml(patient) {
    const payments = D.normalizedPayments(patient).sort((a, b) => `${b.date}|${b.createdAt}`.localeCompare(`${a.date}|${a.createdAt}`));
    if (!payments.length) return '<div class="notes-box">No payment transactions were recorded.</div>';
    const plan = D.planSummary(patient);
    const installmentNumbers = new Map((plan?.installments || []).map((item) => [item.id, item.number]));
    return `
      <div class="history-wrap">
        <table class="history-table payment-ledger-table">
          <thead><tr><th>Date</th><th>Type</th><th>Assigned</th><th>Scheduled Payment</th><th>Amount</th><th>Username</th><th>Office Site</th><th>Method</th><th>Note</th></tr></thead>
          <tbody>${payments.map((payment) => {
            const effect = D.transactionEffect(payment);
            const scheduledNumber = payment.installmentId ? installmentNumbers.get(payment.installmentId) : null;
            return `<tr>
              <td>${D.formatDate(payment.date)}</td>
              <td><span class="ledger-type ${effect < 0 ? "negative" : "positive"}">${D.escapeHtml(payment.type)}</span></td>
              <td><strong>${payment.responsibilityParty === "UF" ? "UF" : "ACC"}</strong></td>
              <td>${scheduledNumber ? `Payment ${scheduledNumber}` : "—"}</td>
              <td><strong class="${effect < 0 ? "negative-money" : ""}">${effect < 0 ? "−" : ""}${D.currency.format(payment.amount)}</strong></td>
              <td>${D.escapeHtml(payment.username || "—")}</td>
              <td>${D.escapeHtml(payment.officeSite || payment.location || "—")}</td>
              <td>${D.escapeHtml(payment.method)}</td>
              <td>${D.escapeHtml(payment.note || "—")}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    `;
  }

  function adjustmentHistoryHtml(patient) {
    const adjustments = D.normalizedAdjustments(patient).sort((a, b) => `${b.date}|${b.createdAt}`.localeCompare(`${a.date}|${a.createdAt}`));
    if (!adjustments.length) return '<div class="notes-box">No adjustments were recorded.</div>';
    return `<div class="history-wrap"><table class="history-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reason</th></tr></thead><tbody>${adjustments.map((entry) => `<tr><td>${D.formatDate(entry.date)}</td><td>${D.escapeHtml(entry.type)}</td><td><strong>${D.currency.format(entry.amount)}</strong></td><td>${D.escapeHtml(entry.note)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function activityTimelineHtml(patient) {
    const activities = (patient.activity || []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!activities.length) return '<div class="notes-box">No activity was recorded.</div>';
    return `<div class="activity-timeline">${activities.map((activity) => `<article class="activity-entry activity-${D.escapeHtml(activity.type)}"><div class="activity-marker" aria-hidden="true"></div><div class="activity-content"><div class="activity-heading"><strong>${D.escapeHtml(activity.title)}</strong><time>${D.formatDateTime(activity.createdAt)}</time></div><p>${D.escapeHtml(activity.detail || "No additional detail.")}</p><span>${D.escapeHtml(activity.actor)}</span></div></article>`).join("")}</div>`;
  }

  function planDetailsHtml(patient) {
    const summary = D.planSummary(patient);
    if (!summary) return "";
    const onTime = summary.onTimeRate === null ? "Not measured" : `${summary.onTimeRate.toFixed(1)}%`;
    return `
      <div class="detail-section">
        <h3>Payment Plan Performance</h3>
        <div class="details-summary plan-summary-cards">
          <div class="mini-card"><span>Completed</span><strong>${summary.completedCount} of ${summary.totalCount}</strong></div>
          <div class="mini-card"><span>Plan progress</span><strong>${summary.progressPercent.toFixed(1)}%</strong></div>
          <div class="mini-card"><span>ACC on-time rate</span><strong>${onTime}</strong></div>
          <div class="mini-card"><span>UF checks due</span><strong>${summary.ufCheckDueCount}</strong></div>
        </div>
        <div class="history-wrap">
          <table class="history-table plan-history-table">
            <thead><tr><th>Payment</th><th>Due date</th><th>Assigned to</th><th>Assigned</th><th>Collected</th><th>Outstanding</th><th>Result</th></tr></thead>
            <tbody>${summary.installments.map((installment) => {
              const result = installment.status === "Paid" ? (installment.onTime ? "Paid on time" : "Paid late") : installment.status;
              const meta = D.statusMeta(installment.status === "Upcoming" ? "Upcoming Collection" : installment.status);
              return `
                <tr>
                  <td><strong>${installment.number}</strong></td>
                  <td>${D.formatDate(installment.dueDate)}</td>
                  <td>${installment.responsibilityParty === "UF" ? "UF" : "ACC"}</td>
                  <td>${D.currency.format(installment.amount)}</td>
                  <td>${D.currency.format(installment.paidAmount)}</td>
                  <td>${D.currency.format(installment.remaining)}</td>
                  <td><span class="status-pill ${meta.pill} compact">${D.escapeHtml(result)}</span></td>
                </tr>
              `;
            }).join("")}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  async function openDetails(patient) {
    detailsPatientId = patient.id;
    const status = D.effectiveStatus(patient);
    const meta = D.statusMeta(status);
    document.getElementById("completedDetailsTitle").textContent = patient.name;
    document.getElementById("completedDetailsSubtitle").textContent = `${patient.mrn} · Completed ${D.formatDate(patient.completedAt)}`;
    document.getElementById("completedDetailsBody").innerHTML = `
      ${(() => { const f = D.financialBreakdown(patient); return `<div class="responsibility-summary-grid"><div class="responsibility-summary-card total"><h3>Total Patient Responsibility</h3><div><span>Total</span><strong>${D.currency.format(f.totalAssigned)}</strong></div><div><span>Collected</span><strong>${D.currency.format(f.totalCollected)}</strong></div><div><span>Outstanding</span><strong>${D.currency.format(f.totalOutstanding)}</strong></div></div><div class="responsibility-summary-card acc"><h3>ACC Assigned Patient Responsibility</h3><div><span>Assigned</span><strong>${D.currency.format(f.accAssigned)}</strong></div><div><span>Collected</span><strong>${D.currency.format(f.accCollected)}</strong></div><div><span>Outstanding</span><strong>${D.currency.format(f.accOutstanding)}</strong></div></div><div class="responsibility-summary-card uf"><h3>UF Assigned Patient Responsibility</h3><div><span>Assigned</span><strong>${D.currency.format(f.ufAssigned)}</strong></div><div><span>Collected</span><strong>${D.currency.format(f.ufCollected)}</strong></div><div><span>Outstanding</span><strong>${D.currency.format(f.ufOutstanding)}</strong></div></div></div>`; })()}
      <div class="completion-summary-callout ${D.amountOwed(patient) > D.EPSILON ? "has-balance" : ""}"><strong>${D.escapeHtml(patient.completionReason || "Completion reason not recorded")}</strong>${patient.completionNote ? ` · ${D.escapeHtml(patient.completionNote)}` : ""}</div>
      <div class="detail-section">
        <h3>Account Details</h3>
        <div class="detail-grid">
          <div class="detail-item"><span>Final status</span><strong><span class="status-pill ${meta.pill}">${D.escapeHtml(status)}</span></strong></div>
          <div class="detail-item"><span>Completion reason</span><strong>${D.escapeHtml(patient.completionReason || "-")}</strong></div>
          ${patient.completionNote ? `<div class="detail-item"><span>Completion note</span><strong>${D.escapeHtml(patient.completionNote)}</strong></div>` : ""}
          <div class="detail-item"><span>Arrangement</span><strong>${D.escapeHtml(D.arrangementFromLegacy(patient))}</strong></div>
          <div class="detail-item"><span>Original collection date</span><strong>${D.formatDate(patient.collectionDate)}</strong></div>
          <div class="detail-item"><span>Treatment flags</span><strong>${D.escapeHtml(D.treatmentLabel(patient))}</strong></div>
          <div class="detail-item"><span>Treatment site</span><strong>${D.escapeHtml(patient.location)}</strong></div>
          <div class="detail-item"><span>Insurance</span><strong>${D.escapeHtml(patient.insurance)}</strong></div>
          <div class="detail-item"><span>Status / action note</span><strong>${D.escapeHtml(patient.statusNote || "-")}</strong></div>
          <div class="detail-item"><span>Account created</span><strong>${D.escapeHtml(D.formatDateTime(patient.createdAt))}</strong></div>
          <div class="detail-item"><span>Last updated</span><strong>${D.escapeHtml(D.formatDateTime(patient.updatedAt || patient.createdAt))}</strong></div>
        </div>
      </div>
      ${planDetailsHtml(patient)}
      <div class="detail-section"><h3>Finance Note</h3><div class="notes-box">${D.escapeHtml(patient.notes || "No finance note entered.")}</div>${patient.noResponsibilityReason ? `<div class="notes-box"><strong>No-responsibility reason:</strong> ${D.escapeHtml(patient.noResponsibilityReason)}</div>` : ""}</div>
      <div class="detail-section"><h3>Payment Ledger</h3>${paymentHistoryHtml(patient)}</div>
      <div class="detail-section"><h3>Adjustments</h3>${adjustmentHistoryHtml(patient)}</div>
      <div class="detail-section"><h3>Activity Timeline</h3>${activityTimelineHtml(patient)}</div>
    `;

    document.getElementById("completedDetailsDocumentsButton").textContent = "Documents";
    if (Docs) {
      try {
        const count = await Docs.count(patient.id);
        document.getElementById("completedDetailsDocumentsButton").textContent = count ? `Documents (${count})` : "Documents";
      } catch (error) {
        console.warn(error);
      }
    }
    elements.detailsDialog.showModal();
  }

  function findPatient(id) {
    return patients.find((patient) => patient.id === id);
  }

  function restorePatient(patient) {
    if (!window.confirm(`Restore ${patient.name} to the active Payment Board?`)) return;
    patient.archived = false;
    patient.completedAt = "";
    patient.completionReason = "";
    patient.completionNote = "";
    D.addActivity(patient, { type: "completion", title: "Account restored to active queue", detail: "Restored from Completed Patients.", date: D.todayIso() });
    D.savePatients(patients);
    if (elements.detailsDialog.open) elements.detailsDialog.close();
    populateFilters();
    render();
    showToast(`${patient.name} restored to the active queue.`);
  }


  function captureCompletedSettings() {
    return {
      search: elements.search.value,
      fromDate: elements.fromDate.value,
      toDate: elements.toDate.value,
      location: elements.location.value,
      treatment: elements.treatment.value,
      status: elements.status.value,
      sort: elements.sort.value
    };
  }

  function renderSavedCompletedViews(selectedId = "") {
    const views = D.loadSavedViews("completed");
    elements.savedViewSelect.innerHTML = '<option value="">Choose a saved view</option>';
    views.forEach((view) => {
      const option = document.createElement("option");
      option.value = view.id;
      option.textContent = view.name;
      elements.savedViewSelect.appendChild(option);
    });
    elements.savedViewSelect.value = views.some((view) => view.id === selectedId) ? selectedId : "";
    document.getElementById("deleteCompletedViewButton").disabled = !elements.savedViewSelect.value;
  }

  function applyCompletedSettings(settings) {
    elements.search.value = settings.search || "";
    elements.fromDate.value = settings.fromDate || "";
    elements.toDate.value = settings.toDate || "";
    elements.location.value = [...elements.location.options].some((option) => option.value === settings.location) ? settings.location : "all";
    elements.treatment.value = [...elements.treatment.options].some((option) => option.value === settings.treatment) ? settings.treatment : "all";
    elements.status.value = [...elements.status.options].some((option) => option.value === settings.status) ? settings.status : "all";
    elements.sort.value = [...elements.sort.options].some((option) => option.value === settings.sort) ? settings.sort : "completedAt:desc";
    sortState = parseSort(elements.sort.value);
    render();
  }

  elements.tbody.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const patient = findPatient(button.dataset.id);
    if (!patient) return;
    if (button.dataset.action === "details") openDetails(patient);
    if (button.dataset.action === "restore") restorePatient(patient);
    if (button.dataset.action === "documents" && Docs) Docs.open(patient);
  });

  document.getElementById("restoreCompletedButton").addEventListener("click", () => {
    const patient = findPatient(detailsPatientId);
    if (patient) restorePatient(patient);
  });
  async function printSummary(patient) {
    let documents = [];
    if (Docs) {
      try { documents = await Docs.list(patient.id); }
      catch (error) { console.warn("Could not load document metadata for printing.", error); }
    }
    const opened = D.printPatientSummary(patient, documents);
    if (!opened) showToast("Allow pop-ups for this site to print the patient summary.", "error");
  }

  document.getElementById("completedDetailsPrintButton").addEventListener("click", () => {
    const patient = findPatient(detailsPatientId);
    if (patient) printSummary(patient);
  });
  document.getElementById("completedDetailsDocumentsButton").addEventListener("click", () => {
    const patient = findPatient(detailsPatientId);
    if (patient && Docs) Docs.open(patient);
  });

  [elements.search, elements.fromDate, elements.toDate, elements.location, elements.treatment, elements.status]
    .forEach((control) => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", render));

  elements.sort.addEventListener("change", () => {
    sortState = parseSort(elements.sort.value);
    render();
  });

  document.querySelectorAll(".sort-button").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      if (sortState.key === key) sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
      else {
        sortState.key = key;
        sortState.direction = ["completedAt", "collected", "planProgress"].includes(key) ? "desc" : "asc";
      }
      const value = `${sortState.key}:${sortState.direction}`;
      const option = [...elements.sort.options].find((item) => item.value === value);
      if (option) elements.sort.value = value;
      render();
    });
  });

  document.getElementById("completedThisMonthButton").addEventListener("click", () => {
    const today = D.todayIso();
    elements.fromDate.value = `${today.slice(0, 7)}-01`;
    elements.toDate.value = today;
    render();
  });

  document.getElementById("clearCompletedFilters").addEventListener("click", () => {
    elements.search.value = "";
    elements.fromDate.value = "";
    elements.toDate.value = "";
    elements.location.value = "all";
    elements.treatment.value = "all";
    elements.status.value = "all";
    render();
  });


  elements.savedViewSelect.addEventListener("change", () => {
    const view = D.loadSavedViews("completed").find((item) => item.id === elements.savedViewSelect.value);
    document.getElementById("deleteCompletedViewButton").disabled = !view;
    if (view) {
      elements.savedViewName.value = view.name;
      applyCompletedSettings(view.settings);
    }
  });

  document.getElementById("saveCompletedViewButton").addEventListener("click", () => {
    const name = elements.savedViewName.value.trim();
    if (!name) return showToast("Enter a name for the saved view.", "error");
    const record = D.saveSavedView("completed", { id: elements.savedViewSelect.value || undefined, name, settings: captureCompletedSettings() });
    renderSavedCompletedViews(record.id);
    showToast(`Saved view “${name}”.`);
  });

  document.getElementById("deleteCompletedViewButton").addEventListener("click", () => {
    const id = elements.savedViewSelect.value;
    if (!id) return;
    const name = elements.savedViewSelect.selectedOptions[0]?.textContent || "this view";
    if (!window.confirm(`Delete saved view "${name}"?`)) return;
    D.deleteSavedView("completed", id);
    elements.savedViewName.value = "";
    renderSavedCompletedViews();
    showToast("Saved view deleted.");
  });

  document.getElementById("exportCompletedButton").addEventListener("click", () => {
    const visiblePatients = filteredPatients();
    if (visiblePatients.length === 0) {
      showToast("No visible completed records to export.", "error");
      return;
    }
    if (!window.AckermanExcel) return showToast("Excel export could not be loaded.", "error");

    const paymentHistories = visiblePatients.map((patient) => D.normalizedPayments(patient)
      .slice()
      .sort((a, b) => `${a.date}|${a.createdAt}`.localeCompare(`${b.date}|${b.createdAt}`)));
    const maxPaymentCount = Math.max(0, ...paymentHistories.map((payments) => payments.length));
    const paymentHeaders = [];
    const paymentTypes = [];
    for (let index = 1; index <= maxPaymentCount; index += 1) {
      paymentHeaders.push(`Payment ${index} Date`, `Payment ${index} Amount`, `Payment ${index} Notes`);
      paymentTypes.push("date", "currency", "wrap");
    }

    const headers = [
      "Completion Date", "Completion Reason", "Completion Note", "Final Status", "Status Note", "Patient Name", "MRN", "Treatment Site", "Treatment Flags", "Insurance",
      "Total Patient Responsibility", "Collected Total Patient Responsibility", "Outstanding Total Patient Responsibility",
      "ACC Assigned Patient Responsibility", "Collected ACC Assigned Patient Responsibility", "Outstanding ACC Assigned Patient Responsibility",
      "UF Assigned Patient Responsibility", "Collected UF Assigned Patient Responsibility", "Outstanding UF Assigned Patient Responsibility",
      "Adjustments", "Days to Complete", "Had Payment Plan", "Plan Installments", "ACC Overdue Payments", "UF Checks Due", "Plan On-Time Rate", "Account Created", "Last Updated",
      ...paymentHeaders
    ];
    const rows = visiblePatients.map((patient, patientIndex) => {
      const plan = D.planSummary(patient);
      const financials = D.financialBreakdown(patient);
      const paymentCells = [];
      const payments = paymentHistories[patientIndex];
      for (let index = 0; index < maxPaymentCount; index += 1) {
        const payment = payments[index];
        if (!payment) {
          paymentCells.push("", "", "");
          continue;
        }
        paymentCells.push(payment.date || "", D.transactionEffect(payment), payment.note || "");
      }
      return [
        patient.completedAt, patient.completionReason || "", patient.completionNote || "", D.effectiveStatus(patient), patient.statusNote || "", patient.name, patient.mrn, patient.location, D.treatmentLabel(patient), patient.insurance,
        financials.totalAssigned, financials.totalCollected, financials.totalOutstanding,
        financials.accAssigned, financials.accCollected, financials.accOutstanding,
        financials.ufAssigned, financials.ufCollected, financials.ufOutstanding,
        financials.adjustments, D.daysBetween(patient.collectionDate, patient.completedAt),
        plan ? "Yes" : "No", plan?.totalCount || 0, plan?.overdueCount || 0, plan?.ufCheckDueCount || 0,
        plan?.onTimeRate === null || !plan ? "" : plan.onTimeRate / 100, patient.createdAt || "", patient.updatedAt || "",
        ...paymentCells
      ];
    });
    const types = [
      "date", "text", "wrap", "text", "wrap", "text", "text", "text", "text", "text",
      "currency", "currency", "currency", "currency", "currency", "currency", "currency", "currency", "currency", "currency",
      "integer", "text", "integer", "integer", "integer", "percent", "datetime", "datetime",
      ...paymentTypes
    ];
    const now = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
    window.AckermanExcel.exportWorkbook({
      filename: `ackerman-completed-current-view-${D.todayIso()}.xlsx`,
      sheetName: "Completed Patients",
      title: "Ackerman Patient Payment Board - Completed Patients",
      subtitle: `${rows.length} visible completed ${rows.length === 1 ? "record" : "records"} · Exported ${now}`,
      headers, rows, types, statusColumn: 3, flagColumns: [24]
    });
    showToast(`${rows.length} visible completed ${rows.length === 1 ? "record" : "records"} exported to Excel.`);
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
  });
  elements.detailsDialog.addEventListener("click", (event) => {
    if (event.target === elements.detailsDialog) elements.detailsDialog.close();
  });

  document.addEventListener("ackerman-docs-changed", (event) => {
    const patientId = event.detail?.patientId;
    if (!patientId) return;
    document.querySelectorAll(`[data-doc-count-for="${CSS.escape(patientId)}"]`).forEach((badge) => {
      const value = Number(event.detail?.count || 0);
      badge.textContent = value;
      badge.hidden = value === 0;
    });
  });


  document.addEventListener("ackerman-document-event", (event) => {
    const patient = findPatient(event.detail?.patientId);
    if (!patient) return;
    D.addActivity(patient, {
      type: "document",
      title: event.detail.action === "deleted" ? "Document deleted" : "Document attached",
      detail: event.detail.name || "Document",
      date: D.todayIso()
    });
    D.savePatients(patients);
    if (elements.detailsDialog.open && detailsPatientId === patient.id) openDetails(patient);
  });

  // Version 3.3: changes saved on other workstations arrive here without a refresh.
  document.addEventListener("ackerman-remote-change", (event) => {
    D.applyPatientUpdates(patients, event.detail?.patients || [], event.detail?.removed);
    populateFilters();
    render();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === D.STORAGE_KEY) {
      patients = D.loadPatients();
      populateFilters();
      render();
    }
    if (event.key === D.SAVED_VIEWS_KEY) renderSavedCompletedViews();
  });

  populateFilters();
  renderSavedCompletedViews();
  render();
})();
