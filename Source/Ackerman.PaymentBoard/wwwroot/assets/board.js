(function () {
  "use strict";

  const D = window.AckermanData;
  const Docs = window.AckermanDocuments;
  if (!D) throw new Error("AckermanData failed to load.");

  let patients = D.loadPatients();
  let sortState = { key: "actionDate", direction: "asc" };
  let detailsPatientId = null;
  let detailsFocus = "overview";
  let paymentsPatientId = null;
  let paymentsScheduleDraft = [];
  let editingPlanSchedule = [];
  let editingPlanPaidMap = new Map();
  let editingExistingPlan = false;
  let editingPatientId = "";
  let originalPlanSnapshot = "";
  let quickFilter = "";
  const collapsedPatientIds = new Set();

  const elements = {
    tbody: document.getElementById("patientTableBody"),
    emptyState: document.getElementById("emptyState"),
    search: document.getElementById("searchInput"),
    statusFilter: document.getElementById("statusFilter"),
    locationFilter: document.getElementById("locationFilter"),
    treatmentFilter: document.getElementById("treatmentFilter"),
    sort: document.getElementById("sortSelect"),
    resultCount: document.getElementById("resultCount"),
    patientDialog: document.getElementById("patientDialog"),
    paymentsDialog: document.getElementById("paymentsDialog"),
    paymentDialog: document.getElementById("paymentDialog"),
    detailsDialog: document.getElementById("detailsDialog"),
    completionDialog: document.getElementById("completionDialog"),
    adjustmentDialog: document.getElementById("adjustmentDialog"),
    transactionDialog: document.getElementById("transactionDialog"),
    paymentPlanSection: document.getElementById("paymentPlanSection"),
    planScheduleBody: document.getElementById("planScheduleBody"),
    planScheduleEmpty: document.getElementById("planScheduleEmpty"),
    planScheduleSummary: document.getElementById("planScheduleSummary"),
    planTargetNote: document.getElementById("planTargetNote"),
    savedViewSelect: document.getElementById("savedViewSelect"),
    savedViewName: document.getElementById("savedViewName"),
    toastRegion: document.getElementById("toastRegion"),
    toggleAllRowsButton: document.getElementById("toggleAllRowsButton")
  };

  function findPatient(id) {
    return patients.find((patient) => patient.id === id);
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
    const locations = [...new Set(patients.map((patient) => patient.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const treatments = [...new Set(patients.flatMap((patient) => D.patientTreatments(patient)))].sort((a, b) => a.localeCompare(b));
    setSelectOptions(elements.locationFilter, locations, "All sites");
    setSelectOptions(elements.treatmentFilter, treatments, "All treatments");
  }

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4600);
  }

  function dateRelativeText(isoDate) {
    if (!isoDate) return "";
    const days = D.daysBetween(D.todayIso(), isoDate);
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days === -1) return "Yesterday";
    if (days > 1) return `In ${days} days`;
    return `${Math.abs(days)} days overdue`;
  }

  function validOperationalDate(isoDate, label, allowBlank = false) {
    if (!isoDate && allowBlank) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) {
      showToast(`${label} is required.`, "error");
      return false;
    }
    const distance = Math.abs(D.daysBetween(D.todayIso(), isoDate));
    if (distance > 3650) {
      showToast(`${label} must be within 10 years of today.`, "error");
      return false;
    }
    return true;
  }

  function parseSortValue(value) {
    const [key, direction] = value.split(":");
    return { key, direction: direction === "desc" ? "desc" : "asc" };
  }

  function frontPageStatus(patient) {
    const arrangement = D.arrangementFromLegacy(patient);
    const owed = D.amountOwed(patient);
    if (arrangement === "No Responsibility" || Number(patient.responsibility || 0) <= 0) return "No Responsibility";
    if (owed <= D.EPSILON) return "Paid in Full";

    const plan = planForPatient(patient);
    if (plan) {
      if ((plan.overdueCount || 0) > 0) return "Overdue";
      if ((plan.dueTodayCount || 0) > 0) return "Due Today";
      return "Upcoming Collection";
    }

    const dueDate = String(patient.collectionDate || "");
    const today = D.todayIso();
    if (dueDate && dueDate < today) return "Overdue";
    if (dueDate === today) return "Due Today";
    return "Upcoming Collection";
  }

  function urgencyRank(patient) {
    const status = frontPageStatus(patient);
    if (status === "Overdue") return 0;
    if (status === "Due Today") return 1;
    const plan = planForPatient(patient);
    if ((plan?.ufCheckDueCount || 0) > 0) return 2;
    if (status === "Upcoming Collection") return 3;
    if (status === "Paid in Full") return 4;
    if (status === "No Responsibility") return 5;
    return 6;
  }

  function sortValue(patient, key) {
    if (key === "status") return urgencyRank(patient);
    if (key === "actionDate") return D.nextActionDate(patient);
    if (key === "owed") return D.amountOwed(patient);
    if (key === "responsibility") return Number(patient.responsibility || 0);
    if (key === "collected") return D.netCollected(patient);
    if (key === "planProgress") return D.planSummary(patient)?.progressPercent ?? 101;
    if (key === "ufCheckAge") return D.planSummary(patient)?.oldestUfCheckDays ?? -1;
    if (key === "treatment") return D.treatmentLabel(patient).toLowerCase();
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

  function matchesStatusFilter(patient, selected) {
    if (selected === "all") return true;
    if (selected === "Overdue or Due Today") {
      const status = frontPageStatus(patient);
      return status === "Overdue" || status === "Due Today";
    }
    if (selected === "UF Check Due") return (planForPatient(patient)?.ufCheckDueCount || 0) > 0;
    return frontPageStatus(patient) === selected;
  }

  function positivePaymentsOnDate(patient, date) {
    return D.normalizedPayments(patient).filter((payment) => payment.date === date && D.transactionEffect(payment) > 0);
  }

  function matchesQuickFilter(patient) {
    if (!quickFilter) return true;
    const status = D.effectiveStatus(patient);
    const attention = D.attentionStatus(patient);
    const plan = status === "Payment Plan" ? D.planSummary(patient) : null;
    if (quickFilter === "Due Today") return attention === "Due Today" || (plan?.dueTodayCount || 0) > 0;
    if (quickFilter === "Overdue") return attention === "Overdue" || (plan?.overdueCount || 0) > 0;
    if (quickFilter === "Plan Attention") return status === "Payment Plan" && ((plan?.overdueCount || 0) > 0 || (plan?.dueTodayCount || 0) > 0 || (plan?.ufCheckDueCount || 0) > 0);
    if (quickFilter === "Partial Overdue") return status === "Partially Paid" && attention === "Overdue";
    if (quickFilter === "Collected Today") return positivePaymentsOnDate(patient, D.todayIso()).length > 0;
    if (quickFilter === "UF Check") return status === "Payment Plan" && (plan?.ufCheckDueCount || 0) > 0;
    return true;
  }

  function filteredPatients() {
    const query = elements.search.value.trim().toLowerCase();
    return patients
      .filter((patient) => {
        if (patient.archived) return false;
        const searchable = [patient.name, patient.mrn, patient.location, D.treatmentLabel(patient), patient.insurance, patient.statusNote]
          .join(" ").toLowerCase();
        return (!query || searchable.includes(query))
          && matchesStatusFilter(patient, elements.statusFilter.value)
          && matchesQuickFilter(patient)
          && (elements.locationFilter.value === "all" || patient.location === elements.locationFilter.value)
          && (elements.treatmentFilter.value === "all" || D.patientTreatments(patient).includes(elements.treatmentFilter.value));
      })
      .sort(comparePatients);
  }

  function statusPillsHtml(patient, clickable = false) {
    const status = frontPageStatus(patient);
    const health = D.patientHealth(patient);
    const primary = clickable
      ? `<button class="status-pill ${health.pill} status-action" data-action="timeline" data-id="${D.escapeHtml(patient.id)}" type="button" title="Open activity timeline">${D.escapeHtml(status)}</button>`
      : `<span class="status-pill ${health.pill}">${D.escapeHtml(status)}</span>`;
    const pills = [primary];

    const plan = planForPatient(patient);
    const overdueCount = plan?.overdueCount || (status === "Overdue" ? 1 : 0);
    if (overdueCount > 0) {
      const overdueClass = overdueCount >= 2 ? "health-red" : "health-yellow";
      const overdueAmount = plan?.overdueAmount ?? D.amountOwed(patient);
      pills.push(`<span class="status-pill status-subline ${overdueClass}">${overdueCount} ${overdueCount === 1 ? "payment" : "payments"} overdue</span>`);
      pills.push(`<span class="status-overdue-amount">Past due: <strong>${D.currency.format(overdueAmount)}</strong></span>`);
    } else if (status === "Due Today") {
      const dueTodayAmount = plan?.dueTodayAmount ?? D.amountOwed(patient);
      if (dueTodayAmount > D.EPSILON) {
        pills.push(`<span class="status-due-amount">Due today: <strong>${D.currency.format(dueTodayAmount)}</strong></span>`);
      }
    }
    if ((plan?.ufCheckDueCount || 0) > 0) {
      const ufLabel = `⚑ Check UF${plan.ufCheckDueCount > 1 ? ` (${plan.ufCheckDueCount})` : ""}`;
      pills.push(clickable
        ? `<button class="status-pill uf-flag uf-flag-action" data-action="uf-check" data-id="${D.escapeHtml(patient.id)}" type="button" title="Open UF payment verification">${D.escapeHtml(ufLabel)}</button>`
        : `<span class="status-pill uf-flag">${D.escapeHtml(ufLabel)}</span>`);
      if (plan.oldestUfCheckDays > 0) {
        pills.push(`<span class="status-pill status-subline uf-age">Oldest ${plan.oldestUfCheckDays} day${plan.oldestUfCheckDays === 1 ? "" : "s"} past due</span>`);
      }
    }

    return `<div class="status-stack">${pills.join("")}</div>`;
  }

  function planForPatient(patient) {
    return D.arrangementFromLegacy(patient) === "Payment Plan" && patient.paymentPlan ? D.planSummary(patient) : null;
  }

  function collectableAmount(patient) {
    const plan = planForPatient(patient);
    return plan ? plan.ackermanOwed : D.amountOwed(patient);
  }

  function actionButtons(patient) {
    const id = D.escapeHtml(patient.id);
    return [
      `<button class="btn btn-primary board-action-btn" data-action="payments" data-id="${id}" type="button">Payments</button>`,
      `<button class="btn btn-documents board-action-btn" data-action="documents" data-id="${id}" type="button">Docs<span class="doc-count" data-doc-count-for="${id}" hidden></span></button>`,
      `<button class="btn btn-ghost board-action-btn" data-action="details" data-id="${id}" type="button">View Details</button>`,
      `<button class="btn btn-success board-action-btn" data-action="complete" data-id="${id}" type="button">Complete</button>`
    ].join("");
  }

  function planProgressHtml(patient) {
    const plan = D.planSummary(patient);
    if (!plan) return "";
    const onTimeText = plan.onTimeRate === null ? "No ACC installments due yet" : `${plan.onTimeRate.toFixed(0)}% paid by due date`;
    return `
      <div class="plan-progress-block">
        <div class="plan-progress-label"><span>${plan.completedCount} of ${plan.totalCount} payments complete</span><strong>${plan.progressPercent.toFixed(0)}%</strong></div>
        <div class="progress-track"><div class="progress-fill health-progress" style="width:${Math.min(100, plan.progressPercent).toFixed(2)}%"></div></div>
        <div class="plan-progress-amounts"><span>${D.currency.format(plan.totalOwed)} still outstanding</span><strong>${plan.remainingPercent.toFixed(0)}% remaining</strong></div>
        <div class="plan-progress-subtext">${D.escapeHtml(onTimeText)}${plan.ufCheckDueCount ? ` · ⚑ ${plan.ufCheckDueCount} UF check${plan.ufCheckDueCount === 1 ? "" : "s"} due` : ""}</div>
      </div>
    `;
  }

  function financialPlanHtml(patient) {
    const f = D.financialBreakdown(patient);
    const signed = (value) => D.currency.format(value);
    return `
      <div class="financial-stack responsibility-financial-stack">
        <div class="financial-group">
          <div class="financial-group-title">Total Patient Responsibility</div>
          <div class="financial-line"><span>Total</span><strong>${signed(f.totalAssigned)}</strong></div>
          <div class="financial-line"><span>Collected</span><strong>${signed(f.totalCollected)}</strong></div>
          <div class="financial-line balance"><span>Outstanding</span><strong>${signed(f.totalOutstanding)}</strong></div>
        </div>
        <div class="financial-group">
          <div class="financial-group-title">ACC Assigned Patient Responsibility</div>
          <div class="financial-line"><span>Assigned</span><strong>${signed(f.accAssigned)}</strong></div>
          <div class="financial-line"><span>Collected</span><strong>${signed(f.accCollected)}</strong></div>
          <div class="financial-line balance"><span>Outstanding</span><strong>${signed(f.accOutstanding)}</strong></div>
        </div>
        <div class="financial-group">
          <div class="financial-group-title">UF Assigned Patient Responsibility</div>
          <div class="financial-line"><span>Assigned</span><strong>${signed(f.ufAssigned)}</strong></div>
          <div class="financial-line"><span>Collected</span><strong>${signed(f.ufCollected)}</strong></div>
          <div class="financial-line balance"><span>Outstanding</span><strong>${signed(f.ufOutstanding)}</strong></div>
        </div>
        ${f.adjustments > D.EPSILON ? `<div class="financial-line financial-adjustment-note"><span>Adjustments</span><strong>${signed(f.adjustments)}</strong></div>` : ""}
      </div>`;
  }

  function compactFinancialSummaryHtml(patient) {
    const f = D.financialBreakdown(patient);
    const plan = planForPatient(patient);
    const status = frontPageStatus(patient);
    let label = "Outstanding";
    let amount = f.totalOutstanding;

    if (status === "Overdue" && plan) {
      label = "Past due";
      amount = plan.overdueAmount || 0;
    } else if (status === "Due Today" && plan) {
      label = "Due today";
      amount = plan.dueTodayAmount || 0;
    } else if (plan?.nextDue) {
      label = "Next payment";
      amount = plan.nextDue.amountDue || 0;
    }

    return `
      <div class="collapsed-financial-summary" aria-label="Compact financial summary">
        <div class="collapsed-financial-primary"><span>${D.escapeHtml(label)}</span><strong>${D.currency.format(amount)}</strong></div>
        <div class="collapsed-financial-secondary">Outstanding ${D.currency.format(f.totalOutstanding)}</div>
      </div>
    `;
  }

  function updateCollapseAllButton(rows) {
    if (!elements.toggleAllRowsButton) return;
    const visibleIds = rows.map((patient) => patient.id);
    const allCollapsed = visibleIds.length > 0 && visibleIds.every((id) => collapsedPatientIds.has(id));
    elements.toggleAllRowsButton.disabled = visibleIds.length === 0;
    elements.toggleAllRowsButton.textContent = allCollapsed ? "▸ Expand All" : "▾ Collapse All";
    elements.toggleAllRowsButton.setAttribute("aria-expanded", allCollapsed ? "false" : "true");
    elements.toggleAllRowsButton.title = allCollapsed ? "Expand all visible patient rows" : "Collapse all visible patient rows";
  }

  function dueCellHtml(patient) {
    if (D.effectiveStatus(patient) === "Payment Plan") {
      const plan = D.planSummary(patient);
      if (!plan?.nextDue) return '<div class="date-main">Plan complete</div><div class="date-relative">No installment remains</div>';
      return `
        <div class="date-kicker">Payment ${plan.nextDue.number} of ${plan.totalCount} · ${D.escapeHtml(plan.nextDue.responsibilityParty)}</div>
        <div class="date-main">${D.formatDate(plan.nextDue.dueDate)}</div>
        <div class="date-relative">${D.escapeHtml(dateRelativeText(plan.nextDue.dueDate))} · ${D.currency.format(plan.nextDue.amountDue)}</div>
      `;
    }
    return `<div class="date-main">${D.formatDate(patient.collectionDate)}</div><div class="date-relative">${D.escapeHtml(dateRelativeText(patient.collectionDate))}</div>`;
  }

  function renderRows() {
    const rows = filteredPatients();
    elements.tbody.innerHTML = "";
    elements.emptyState.hidden = rows.length > 0;
    document.querySelector(".payment-table").hidden = rows.length === 0;

    rows.forEach((patient) => {
      const status = D.effectiveStatus(patient);
      const health = D.patientHealth(patient);
      const owed = D.amountOwed(patient);
      const tr = document.createElement("tr");
      const isCollapsed = collapsedPatientIds.has(patient.id);
      tr.className = `${health.row} patient-row${isCollapsed ? " is-collapsed" : ""}`;
      tr.dataset.patientId = patient.id;
      tr.innerHTML = `
        <td data-label="Status">${statusPillsHtml(patient, true)}<input class="status-note-input" data-status-note-id="${D.escapeHtml(patient.id)}" maxlength="120" value="${D.escapeHtml(patient.statusNote || "")}" placeholder="Quick note (e.g. Call patient)" aria-label="Quick status note for ${D.escapeHtml(patient.name)}"></td>
        <td data-label="Patient">
          <div class="patient-cell-heading">
            <button class="row-collapse-toggle" type="button" data-action="toggle-row" data-id="${D.escapeHtml(patient.id)}" aria-expanded="${isCollapsed ? "false" : "true"}" aria-label="${isCollapsed ? "Expand" : "Collapse"} ${D.escapeHtml(patient.name)}" title="${isCollapsed ? "Expand patient row" : "Collapse patient row"}">${isCollapsed ? "▸" : "▾"}</button>
            <button class="patient-link" type="button" data-action="details" data-id="${D.escapeHtml(patient.id)}">${D.escapeHtml(patient.name)}</button>
          </div>
          <div class="mrn">${D.escapeHtml(patient.mrn)}</div><div class="cell-tertiary">Updated ${D.escapeHtml(D.formatDateTime(patient.updatedAt || patient.createdAt))}</div>
        </td>
        <td data-label="Treatment"><div class="treatment-badges">${D.patientTreatments(patient).map((treatment) => `<span class="treatment-badge">${D.escapeHtml(treatment)}</span>`).join("")}</div></td>
        <td data-label="Site & Insurance"><div class="cell-primary">${D.escapeHtml(patient.location)}</div><div class="cell-secondary">${D.escapeHtml(patient.insurance)}</div></td>
        <td data-label="Financials / Plan">
          <div class="expanded-financial-content">${financialPlanHtml(patient)}${planProgressHtml(patient)}</div>
          ${compactFinancialSummaryHtml(patient)}
        </td>
        <td data-label="Next Due">${dueCellHtml(patient)}</td>
        <td class="actions-cell" data-label="Actions"><div class="actions">${actionButtons(patient)}</div></td>
      `;
      elements.tbody.appendChild(tr);
    });

    updateCollapseAllButton(rows);
    const quickText = quickFilter ? ` · quick filter: ${quickFilter}` : "";
    elements.resultCount.textContent = `${rows.length} ${rows.length === 1 ? "record" : "records"}${quickText}`;
    updateDocumentCounts(rows);
  }

  async function updateDocumentCounts(rows = patients.filter((patient) => !patient.archived)) {
    if (!Docs) return;
    await Promise.all(rows.map(async (patient) => {
      try {
        const value = await Docs.count(patient.id);
        document.querySelectorAll(`[data-doc-count-for="${CSS.escape(patient.id)}"]`).forEach((badge) => {
          badge.textContent = value;
          badge.hidden = value === 0;
        });
      } catch (error) {
        console.warn("Could not count prototype documents.", error);
      }
    }));
  }

  function operationalData() {
    const active = patients.filter((patient) => !patient.archived);
    const today = D.todayIso();
    const dueToday = active.filter((patient) => {
      const plan = D.effectiveStatus(patient) === "Payment Plan" ? D.planSummary(patient) : null;
      return D.attentionStatus(patient) === "Due Today" || (plan?.dueTodayCount || 0) > 0;
    });
    const overdue = active.filter((patient) => {
      const plan = D.effectiveStatus(patient) === "Payment Plan" ? D.planSummary(patient) : null;
      return D.attentionStatus(patient) === "Overdue" || (plan?.overdueCount || 0) > 0;
    });
    const planAttention = active.filter((patient) => {
      if (D.effectiveStatus(patient) !== "Payment Plan") return false;
      const plan = D.planSummary(patient);
      return (plan?.overdueCount || 0) > 0 || (plan?.dueTodayCount || 0) > 0 || (plan?.ufCheckDueCount || 0) > 0;
    });
    const planInstallmentsDue = planAttention.reduce((sum, patient) => {
      const plan = D.planSummary(patient);
      return sum + Number(plan?.overdueCount || 0) + Number(plan?.dueTodayCount || 0) + Number(plan?.ufCheckDueCount || 0);
    }, 0);
    const partialOverdue = active.filter((patient) => D.effectiveStatus(patient) === "Partially Paid" && D.attentionStatus(patient) === "Overdue");
    const paymentsToday = active.flatMap((patient) => positivePaymentsOnDate(patient, today));
    const ufChecks = active.filter((patient) => D.effectiveStatus(patient) === "Payment Plan" && (D.planSummary(patient)?.ufCheckDueCount || 0) > 0);
    return { active, dueToday, overdue, planAttention, planInstallmentsDue, partialOverdue, paymentsToday, ufChecks };
  }

  function renderSummary() {
    const ops = operationalData();
    const eligible = ops.active.filter((patient) => D.effectiveStatus(patient) !== "No Responsibility");
    const outstanding = ops.active.reduce((sum, patient) => sum + D.amountOwed(patient), 0);
    const responsibility = eligible.reduce((sum, patient) => sum + Number(patient.responsibility || 0), 0);
    const collected = eligible.reduce((sum, patient) => sum + D.netCollected(patient), 0);
    const planPatients = ops.active.filter((patient) => D.effectiveStatus(patient) === "Payment Plan");
    const receivedToday = ops.paymentsToday.reduce((sum, payment) => sum + payment.amount, 0);
    const rate = responsibility > 0 ? Math.min(100, (collected / responsibility) * 100) : 0;

    document.getElementById("activeCount").textContent = ops.active.length.toLocaleString();
    document.getElementById("activeSubtext").textContent = `${ops.dueToday.length} due today`;
    document.getElementById("outstandingAmount").textContent = D.currency.format(outstanding);
    document.getElementById("planCount").textContent = planPatients.length.toLocaleString();
    document.getElementById("planAttention").textContent = `${ops.planAttention.length} needing attention`;
    document.getElementById("collectionRate").textContent = `${rate.toFixed(1)}%`;

    document.getElementById("opsDueToday").textContent = ops.dueToday.length;
    document.getElementById("opsOverdue").textContent = ops.overdue.length;
    document.getElementById("opsOverdueAmount").textContent = `${D.currency.format(ops.overdue.reduce((sum, patient) => sum + D.amountOwed(patient), 0))} exposed`;
    document.getElementById("opsPlanAttention").textContent = ops.planInstallmentsDue;
    document.getElementById("opsPlanAttentionContext").textContent = `across ${ops.planAttention.length} ${ops.planAttention.length === 1 ? "payment plan" : "payment plans"}`;
    document.getElementById("opsPartialOverdue").textContent = ops.partialOverdue.length;
    document.getElementById("opsCollectedToday").textContent = D.currency.format(receivedToday);
    document.getElementById("opsTransactionCount").textContent = `${ops.paymentsToday.length} transactions`;
    document.getElementById("opsUfChecks").textContent = ops.ufChecks.length;
    const oldestUfDays = ops.ufChecks.reduce((max, patient) => Math.max(max, D.planSummary(patient)?.oldestUfCheckDays || 0), 0);
    document.getElementById("opsUfChecksContext").textContent = oldestUfDays > 0
      ? `Oldest UF check is ${oldestUfDays} day${oldestUfDays === 1 ? "" : "s"} past due`
      : "UF-assigned payments past due with no UF payment recorded";

    document.querySelectorAll("[data-quick-filter]").forEach((button) => {
      button.classList.toggle("active", button.dataset.quickFilter === quickFilter);
    });
  }

  function updateSortIndicators() {
    document.querySelectorAll(".sort-button").forEach((button) => {
      const indicator = button.querySelector(".sort-indicator");
      const active = button.dataset.sortKey === sortState.key;
      indicator.textContent = active ? (sortState.direction === "asc" ? "▲" : "▼") : "";
    });
  }

  function render() {
    renderRows();
    renderSummary();
    updateSortIndicators();
    const refreshed = document.getElementById("boardRefreshedAt");
    if (refreshed) refreshed.textContent = `Browser data refreshed ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`;
  }

  // Saved views -------------------------------------------------------------
  function captureViewSettings() {
    return {
      search: elements.search.value,
      status: elements.statusFilter.value,
      location: elements.locationFilter.value,
      treatment: elements.treatmentFilter.value,
      sort: elements.sort.value,
      quickFilter
    };
  }

  function renderSavedViews(selectedId = "") {
    const views = D.loadSavedViews("board");
    elements.savedViewSelect.innerHTML = '<option value="">Choose a saved view</option>';
    views.forEach((view) => {
      const option = document.createElement("option");
      option.value = view.id;
      option.textContent = view.name;
      elements.savedViewSelect.appendChild(option);
    });
    elements.savedViewSelect.value = views.some((view) => view.id === selectedId) ? selectedId : "";
    document.getElementById("deleteViewButton").disabled = !elements.savedViewSelect.value;
  }

  function applyViewSettings(settings) {
    elements.search.value = settings.search || "";
    const migratedStatus = settings.status === "Overdue and Due Today" ? "Overdue or Due Today" : settings.status;
    elements.statusFilter.value = [...elements.statusFilter.options].some((option) => option.value === migratedStatus) ? migratedStatus : "all";
    elements.locationFilter.value = [...elements.locationFilter.options].some((option) => option.value === settings.location) ? settings.location : "all";
    elements.treatmentFilter.value = [...elements.treatmentFilter.options].some((option) => option.value === settings.treatment) ? settings.treatment : "all";
    elements.sort.value = [...elements.sort.options].some((option) => option.value === settings.sort) ? settings.sort : "actionDate:asc";
    sortState = parseSortValue(elements.sort.value);
    quickFilter = settings.quickFilter || "";
    render();
  }

  // Payment plan editor -----------------------------------------------------
  function editingPatient() {
    return editingPatientId ? findPatient(editingPatientId) : null;
  }

  function planTargetAmount() {
    const responsibility = Math.max(0, Number(document.getElementById("patientResponsibility").value || 0));
    const openingCollected = Math.max(0, Number(document.getElementById("planOpeningCollected").value || 0));
    const adjustments = editingPatient() ? D.adjustmentTotal(editingPatient()) : 0;
    return Math.max(0, Math.round((responsibility - openingCollected - adjustments) * 100) / 100);
  }

  function readPlanScheduleFromDom() {
    return [...elements.planScheduleBody.querySelectorAll("tr")].map((row, index) => {
      const selectedParty = row.querySelector("input[data-plan-field='responsibilityParty']:checked")?.value || "Ackerman";
      return {
        id: row.dataset.installmentId || D.uid(`installment-${index + 1}`),
        dueDate: row.querySelector("input[data-plan-field='dueDate']")?.value || "",
        originalDueDate: row.dataset.originalDueDate || row.querySelector("input[data-plan-field='dueDate']")?.value || "",
        amount: Number(row.querySelector("input[data-plan-field='amount']")?.value || 0),
        responsibilityParty: selectedParty === "UF" ? "UF" : "Ackerman",
        ufVerified: false,
        ufVerifiedAt: "",
        rescheduledAt: row.dataset.rescheduledAt || ""
      };
    });
  }

  function planSnapshot(planData) {
    return JSON.stringify({
      installments: (planData.installments || []).map((item) => ({
        id: item.id,
        dueDate: item.dueDate,
        amount: Number(item.amount || 0).toFixed(2),
        responsibilityParty: item.responsibilityParty === "UF" ? "UF" : "Ackerman"
      }))
    });
  }

  function renderPlanEditor() {
    elements.planScheduleBody.innerHTML = "";
    elements.planScheduleEmpty.hidden = editingPlanSchedule.length > 0;

    editingPlanSchedule.forEach((installment, index) => {
      const paid = editingPlanPaidMap.get(installment.id) || 0;
      const party = installment.responsibilityParty === "UF" ? "UF" : "Ackerman";
      const row = document.createElement("tr");
      row.dataset.installmentId = installment.id;
      row.dataset.originalDueDate = installment.originalDueDate || installment.dueDate;
      row.dataset.rescheduledAt = installment.rescheduledAt || "";
      row.innerHTML = `
        <td><strong>Payment ${index + 1}</strong></td>
        <td><input type="date" data-plan-field="dueDate" value="${D.escapeHtml(installment.dueDate)}" aria-label="Payment ${index + 1} due date"></td>
        <td><div class="money-input"><span>$</span><input type="number" min="0.01" step="0.01" data-plan-field="amount" value="${Number(installment.amount || 0).toFixed(2)}" aria-label="Payment ${index + 1} amount"></div></td>
        <td><div class="installment-editor-progress"><strong>${D.currency.format(paid)}</strong><span>recorded</span></div></td>
        <td>
          <div class="responsibility-choice" role="group" aria-label="Payment ${index + 1} responsibility">
            <label class="responsibility-option"><input type="radio" name="responsibility-${index}" data-plan-field="responsibilityParty" value="Ackerman" ${party === "Ackerman" ? "checked" : ""}> <span>ACC responsible</span></label>
            <label class="responsibility-option"><input type="radio" name="responsibility-${index}" data-plan-field="responsibilityParty" value="UF" ${party === "UF" ? "checked" : ""}> <span>UF responsible</span></label>
          </div>
        </td>
      `;
      elements.planScheduleBody.appendChild(row);
    });
    updatePlanEditorSummary();
  }

  function updatePlanEditorSummary() {
    if (elements.planScheduleBody.children.length) editingPlanSchedule = readPlanScheduleFromDom();
    const target = planTargetAmount();
    const total = editingPlanSchedule.reduce((sum, installment) => sum + Number(installment.amount || 0), 0);
    const difference = Math.round((total - target) * 100) / 100;
    const opening = Number(document.getElementById("planOpeningCollected").value || 0);
    const ackermanCount = editingPlanSchedule.filter((item) => item.responsibilityParty !== "UF").length;
    const ufCount = editingPlanSchedule.filter((item) => item.responsibilityParty === "UF").length;
    elements.planTargetNote.textContent = `Reference target: ${D.currency.format(target)} · Collected before plan: ${D.currency.format(opening)} · Manual schedule total: ${D.currency.format(total)}`;
    elements.planScheduleSummary.className = "plan-total-row manual";
    elements.planScheduleSummary.innerHTML = `<span>${editingPlanSchedule.length} payments · ${ackermanCount} ACC · ${ufCount} UF</span><span>Difference from reference target: <strong>${D.currency.format(difference)}</strong></span><span>Informational only — manual schedules can still be saved.</span>`;
  }

  function buildPlanSchedule() {
    const requestedCount = Math.max(1, Math.min(24, Math.floor(Number(document.getElementById("planInstallmentCount").value || 1))));
    const firstDate = document.getElementById("planFirstDueDate").value || D.todayIso();
    const frequency = document.getElementById("planFrequency").value;
    if (!validOperationalDate(firstDate, "First due date")) return;
    if (editingExistingPlan && editingPlanSchedule.length && !window.confirm("Replace the current payment schedule with a newly generated schedule?")) return;
    if (!editingExistingPlan) {
      document.getElementById("planOpeningCollected").value = String(Math.max(0, Number(document.getElementById("patientCollected").value || 0)));
    }

    editingPlanSchedule = D.makePlanSchedule(planTargetAmount(), requestedCount, firstDate, frequency);
    document.getElementById("patientDate").value = editingPlanSchedule[0]?.dueDate || firstDate;
    renderPlanEditor();
    showToast("Payment schedule generated. Due dates, amounts, and responsibility can now be edited manually.");
  }

  function toggleArrangementSection({ autoBuild = false } = {}) {
    const arrangement = document.getElementById("patientArrangement").value;
    const isPlan = arrangement === "Payment Plan";
    const noResponsibility = arrangement === "No Responsibility";
    elements.paymentPlanSection.hidden = !isPlan;
    document.getElementById("noResponsibilityReasonField").hidden = !noResponsibility;
    document.getElementById("noResponsibilityReason").required = noResponsibility;
    document.getElementById("collectionDateHint").textContent = isPlan
      ? "For payment plans, this follows the first scheduled payment."
      : "Not used when there is no payment responsibility.";
    if (noResponsibility) {
      document.getElementById("patientResponsibility").value = "0";
      document.getElementById("patientResponsibility").disabled = true;
    } else {
      document.getElementById("patientResponsibility").disabled = false;
    }
    if (isPlan && autoBuild && !editingPlanSchedule.length) buildPlanSchedule();
    if (isPlan) updatePlanEditorSummary();
  }

  function openPatientDialog(patient = null) {
    const isEditing = Boolean(patient);
    editingPatientId = patient?.id || "";
    document.getElementById("patientDialogTitle").textContent = isEditing ? "Edit Patient Account" : "Add Patient";
    document.getElementById("patientId").value = patient?.id || "";
    document.getElementById("patientName").value = patient?.name || "";
    document.getElementById("patientMrn").value = patient?.mrn || "";
    document.getElementById("patientLocation").value = patient?.location || "Jacksonville";
    const selectedTreatments = new Set(patient ? D.patientTreatments(patient) : ["Proton"]);
    document.querySelectorAll('input[name="patientTreatmentFlag"]').forEach((checkbox) => { checkbox.checked = selectedTreatments.has(checkbox.value); });
    document.getElementById("patientInsurance").value = patient?.insurance || "";
    document.getElementById("patientResponsibility").value = patient?.responsibility ?? "";
    document.getElementById("patientCollected").value = "0";
    document.getElementById("patientDate").value = patient?.collectionDate || D.todayIso();
    document.getElementById("patientArrangement").value = patient ? D.arrangementFromLegacy(patient) : "Payment Plan";
    document.getElementById("patientStatusNote").value = patient?.statusNote || "";
    document.getElementById("noResponsibilityReason").value = patient?.noResponsibilityReason || "";
    document.getElementById("patientNotes").value = patient?.notes || "";

    editingExistingPlan = Boolean(patient?.paymentPlan);
    const planSummary = patient?.paymentPlan ? D.planSummary(patient) : null;
    editingPlanPaidMap = new Map((planSummary?.installments || []).map((installment) => [installment.id, installment.paidAmount]));
    editingPlanSchedule = patient?.paymentPlan?.installments ? D.deepCopy(patient.paymentPlan.installments) : [];
    document.getElementById("planOpeningCollected").value = "0";
    document.getElementById("planInstallmentCount").value = String(editingPlanSchedule.length || 1);
    document.getElementById("planFirstDueDate").value = editingPlanSchedule[0]?.dueDate || patient?.collectionDate || D.todayIso();
    document.getElementById("planFrequency").value = "monthly";
    originalPlanSnapshot = patient?.paymentPlan ? planSnapshot(patient.paymentPlan) : "";
    renderPlanEditor();
    toggleArrangementSection();

    elements.patientDialog.showModal();
    document.getElementById("patientName").focus();
  }

  // Payment, adjustment, and transaction dialogs ------------------
  // Payment, adjustment, and transaction dialogs ------------------
  function defaultOfficeSite(patient) {
    const map = {
      "Jacksonville": "ACC Mandarin",
      "Amelia Island": "ACC Amelia Island",
      "Urology World Golf Village": "Urology World Golf Village",
      "Urology Middleburg": "Urology Middleburg"
    };
    return map[patient.location] || "ACC Mandarin";
  }

  function paymentsScheduleSnapshot(schedule = paymentsScheduleDraft) {
    return JSON.stringify((schedule || []).map((item) => ({
      id: item.id, dueDate: item.dueDate, amount: Number(item.amount || 0).toFixed(2),
      responsibilityParty: item.responsibilityParty === "UF" ? "UF" : "Ackerman"
    })));
  }

  function readPaymentsScheduleDraft() {
    const body = document.getElementById("paymentsScheduleBody");
    if (!body) return [];
    return [...body.querySelectorAll("tr[data-installment-id]")].map((row) => ({
      id: row.dataset.installmentId,
      dueDate: row.querySelector("input[data-workspace-field='dueDate']")?.value || "",
      originalDueDate: row.dataset.originalDueDate || row.querySelector("input[data-workspace-field='dueDate']")?.value || "",
      amount: Number(row.querySelector("input[data-workspace-field='amount']")?.value || 0),
      responsibilityParty: row.querySelector("select[data-workspace-field='party']")?.value === "UF" ? "UF" : "Ackerman",
      ufVerified: false, ufVerifiedAt: "", rescheduledAt: row.dataset.rescheduledAt || "",
      isNew: row.dataset.isNew === "true"
    }));
  }

  function paymentsFinancialSummaryHtml(patient) {
    const f = D.financialBreakdown(patient);
    return `
      <div class="responsibility-summary-grid">
        <div class="responsibility-summary-card total"><h3>Total Patient Responsibility</h3><div><span>Total</span><strong>${D.currency.format(f.totalAssigned)}</strong></div><div><span>Collected</span><strong>${D.currency.format(f.totalCollected)}</strong></div><div><span>Outstanding</span><strong>${D.currency.format(f.totalOutstanding)}</strong></div></div>
        <div class="responsibility-summary-card acc"><h3>ACC Assigned Patient Responsibility</h3><div><span>Assigned</span><strong>${D.currency.format(f.accAssigned)}</strong></div><div><span>Collected</span><strong>${D.currency.format(f.accCollected)}</strong></div><div><span>Outstanding</span><strong>${D.currency.format(f.accOutstanding)}</strong></div></div>
        <div class="responsibility-summary-card uf"><h3>UF Assigned Patient Responsibility</h3><div><span>Assigned</span><strong>${D.currency.format(f.ufAssigned)}</strong></div><div><span>Collected</span><strong>${D.currency.format(f.ufCollected)}</strong></div><div><span>Outstanding</span><strong>${D.currency.format(f.ufOutstanding)}</strong></div></div>
      </div>`;
  }

  function renderPaymentsWorkspace(patient) {
    const savedSummary = D.planSummary(patient);
    const savedById = new Map((savedSummary?.installments || []).map((item) => [item.id, item]));
    document.getElementById("paymentsFinancialSummary").innerHTML = paymentsFinancialSummaryHtml(patient);
    const body = document.getElementById("paymentsScheduleBody");
    body.innerHTML = "";

    paymentsScheduleDraft.forEach((installment, index) => {
      const saved = savedById.get(installment.id);
      const party = installment.responsibilityParty === "UF" ? "UF" : "Ackerman";
      const collected = saved?.paidAmount || 0;
      const outstanding = Number(installment.amount || 0) - collected;
      const status = saved?.status || (installment.isNew ? "New — save schedule" : "Scheduled");
      const row = document.createElement("tr");
      row.dataset.installmentId = installment.id;
      row.dataset.originalDueDate = installment.originalDueDate || installment.dueDate || "";
      row.dataset.rescheduledAt = installment.rescheduledAt || "";
      row.dataset.isNew = installment.isNew ? "true" : "false";
      row.innerHTML = `
        <td><strong>${index + 1}</strong></td>
        <td><input type="date" data-workspace-field="dueDate" value="${D.escapeHtml(installment.dueDate || "")}" aria-label="Payment ${index + 1} due date"></td>
        <td><div class="money-input"><span>$</span><input type="number" min="0.01" step="0.01" data-workspace-field="amount" value="${Number(installment.amount || 0).toFixed(2)}" aria-label="Payment ${index + 1} assigned amount"></div></td>
        <td><select data-workspace-field="party" aria-label="Payment ${index + 1} assigned party"><option value="Ackerman" ${party === "Ackerman" ? "selected" : ""}>ACC</option><option value="UF" ${party === "UF" ? "selected" : ""}>UF</option></select></td>
        <td><strong>${D.currency.format(collected)}</strong></td>
        <td><strong>${D.currency.format(outstanding)}</strong></td>
        <td>${installment.isNew ? '<span class="status-pill health-green compact">Save first</span>' : `<span class="status-pill ${saved?.ufCheckDue ? "uf-flag" : (saved?.status === "Overdue" ? "health-yellow" : "health-green")} compact">${D.escapeHtml(status)}</span>${saved?.ufCheckDue ? `<div class="uf-check-inline-flag">⚑ ${saved.daysLate} day${saved.daysLate === 1 ? "" : "s"} past due</div>` : ""}`}</td>
        <td><div class="schedule-row-actions"><button class="btn btn-primary btn-small" type="button" data-payments-action="record" data-installment-id="${D.escapeHtml(installment.id)}" ${installment.isNew ? "disabled" : ""}>Record Payment</button><button class="btn btn-ghost btn-small" type="button" data-payments-action="remove" data-installment-id="${D.escapeHtml(installment.id)}">Remove</button></div></td>
      `;
      body.appendChild(row);
    });

    const total = paymentsScheduleDraft.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const acc = paymentsScheduleDraft.filter((item) => item.responsibilityParty !== "UF").reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const uf = paymentsScheduleDraft.filter((item) => item.responsibilityParty === "UF").reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const delta = Math.round((total - Number(patient.responsibility || 0)) * 100) / 100;
    document.getElementById("paymentsScheduleSummary").innerHTML = `<span>${paymentsScheduleDraft.length} scheduled payment${paymentsScheduleDraft.length === 1 ? "" : "s"} · ACC ${D.currency.format(acc)} · UF ${D.currency.format(uf)}</span><span>Schedule total: <strong>${D.currency.format(total)}</strong> · Difference from Total Patient Responsibility: <strong>${D.currency.format(delta)}</strong></span><span>Changing the schedule does not change Total Patient Responsibility.</span>`;
    document.getElementById("paymentsLedger").innerHTML = paymentHistoryHtml(patient, true);
  }

  function refreshPaymentsScheduleSummary(patient) {
    const total = paymentsScheduleDraft.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const acc = paymentsScheduleDraft.filter((item) => item.responsibilityParty !== "UF").reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const uf = paymentsScheduleDraft.filter((item) => item.responsibilityParty === "UF").reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const delta = Math.round((total - Number(patient.responsibility || 0)) * 100) / 100;
    document.getElementById("paymentsScheduleSummary").innerHTML = `<span>${paymentsScheduleDraft.length} scheduled payment${paymentsScheduleDraft.length === 1 ? "" : "s"} · ACC ${D.currency.format(acc)} · UF ${D.currency.format(uf)}</span><span>Schedule total: <strong>${D.currency.format(total)}</strong> · Difference from Total Patient Responsibility: <strong>${D.currency.format(delta)}</strong></span><span>Changing the schedule does not change Total Patient Responsibility.</span>`;
  }

  function openPaymentsDialog(patient) {
    paymentsPatientId = patient.id;
    document.getElementById("paymentsTitle").textContent = `Payments — ${patient.name}`;
    document.getElementById("paymentsSubtitle").textContent = `${patient.mrn} · Edit the schedule or record an ACC / UF payment.`;
    paymentsScheduleDraft = patient.paymentPlan?.installments ? D.deepCopy(patient.paymentPlan.installments).map((item) => ({ ...item, isNew: false })) : [];
    renderPaymentsWorkspace(patient);
    const noResponsibility = D.arrangementFromLegacy(patient) === "No Responsibility";
    document.getElementById("addScheduledPaymentButton").disabled = noResponsibility;
    document.getElementById("savePaymentScheduleButton").disabled = noResponsibility;
    document.getElementById("paymentsAdjustmentButton").disabled = noResponsibility;
    if (!elements.paymentsDialog.open) elements.paymentsDialog.showModal();
  }

  function openPaymentDialog(patient, installmentId) {
    const summary = D.planSummary(patient);
    const installment = summary?.installments.find((item) => item.id === installmentId);
    if (!installment) return showToast("Save the schedule before recording a payment.", "error");

    document.getElementById("paymentPatientId").value = patient.id;
    document.getElementById("paymentInstallmentId").value = installment.id;
    document.getElementById("paymentResponsibilityParty").value = installment.responsibilityParty;
    document.getElementById("paymentPatientName").textContent = patient.name;
    document.getElementById("paymentPatientMrn").textContent = patient.mrn;
    document.getElementById("paymentAssignedParty").textContent = installment.responsibilityParty === "UF" ? "UF" : "ACC";
    document.getElementById("paymentScheduledAmount").textContent = D.currency.format(installment.amount);
    document.getElementById("paymentAlreadyCollected").textContent = D.currency.format(installment.paidAmount);
    document.getElementById("paymentBalance").textContent = D.currency.format(installment.amountDue);
    document.getElementById("paymentAmount").value = installment.amountDue > D.EPSILON ? installment.amountDue.toFixed(2) : "";
    document.getElementById("paymentDate").value = D.todayIso();
    document.getElementById("paymentUsername").value = window.AckermanSession?.username || "";
    document.getElementById("paymentOfficeSite").value = defaultOfficeSite(patient);
    document.getElementById("paymentMethod").value = "Credit/Debit Card";
    document.getElementById("paymentNote").value = "";
    document.getElementById("paymentPlanContext").innerHTML = `<div><strong>Scheduled payment ${installment.number} of ${summary.totalCount}</strong> · ${D.currency.format(installment.amount)} due ${D.formatDate(installment.dueDate)} · ${installment.responsibilityParty === "UF" ? "UF" : "ACC"} assigned.</div><div class="field-hint">Recording a different amount updates Collected totals only. It does not rewrite the assigned schedule.</div>`;
    if (elements.paymentsDialog.open) elements.paymentsDialog.close();
    elements.paymentDialog.showModal();
    document.getElementById("paymentAmount").focus();
  }

  function openAdjustmentDialog(patient) {
    const balance = D.amountOwed(patient);
    document.getElementById("adjustmentPatientId").value = patient.id;
    document.getElementById("adjustmentPatientLabel").textContent = `${patient.name} · ${patient.mrn}`;
    document.getElementById("adjustmentBalance").textContent = D.currency.format(balance);
    document.getElementById("adjustmentExisting").textContent = D.currency.format(D.adjustmentTotal(patient));
    document.getElementById("adjustmentAfter").textContent = D.currency.format(balance);
    document.getElementById("adjustmentType").value = "Adjustment";
    document.getElementById("adjustmentAmount").value = "";
    document.getElementById("adjustmentAmount").max = String(balance);
    document.getElementById("adjustmentDate").value = D.todayIso();
    document.getElementById("adjustmentNote").value = "";
    elements.adjustmentDialog.showModal();
    document.getElementById("adjustmentAmount").focus();
  }

  function openTransactionDialog(patient, transaction) {
    const available = D.reversibleAmount(patient, transaction.id);
    document.getElementById("transactionPatientId").value = patient.id;
    document.getElementById("transactionId").value = transaction.id;
    document.getElementById("transactionPatientLabel").textContent = `${patient.name} · ${D.formatDate(transaction.date)} · ${transaction.method}`;
    document.getElementById("transactionOriginal").textContent = D.currency.format(transaction.amount);
    document.getElementById("transactionAvailable").textContent = D.currency.format(available);
    document.getElementById("transactionBalance").textContent = D.currency.format(D.amountOwed(patient));
    document.getElementById("transactionAction").value = "Reversal";
    document.getElementById("transactionAmount").value = available.toFixed(2);
    document.getElementById("transactionAmount").max = String(available);
    document.getElementById("transactionDate").value = D.todayIso();
    document.getElementById("correctedAmount").value = available.toFixed(2);
    document.getElementById("correctedMethod").value = transaction.method;
    document.getElementById("transactionReason").value = "";
    toggleCorrectionFields();
    elements.transactionDialog.showModal();
  }

  function toggleCorrectionFields() {
    const correction = document.getElementById("transactionAction").value === "Correction";
    document.querySelectorAll(".correction-field").forEach((field) => { field.hidden = !correction; });
    document.getElementById("correctedAmount").required = correction;
    document.getElementById("correctedMethod").required = correction;
  }

  // Details and timeline ----------------------------------------------------
  function paymentHistoryHtml(patient, editable = false) {
    const payments = D.normalizedPayments(patient).sort((a, b) => `${b.date}|${b.createdAt}`.localeCompare(`${a.date}|${a.createdAt}`));
    if (!payments.length) return '<div class="notes-box">No payment transactions have been recorded.</div>';
    const plan = D.planSummary(patient);
    const installmentNumbers = new Map((plan?.installments || []).map((item) => [item.id, item.number]));
    return `<div class="history-wrap"><table class="history-table payment-ledger-table"><thead><tr><th>Date</th><th>Type</th><th>Assigned</th><th>Scheduled Payment</th><th>Amount</th><th>Username</th><th>Office Site</th><th>Method</th><th>Note</th>${editable ? "<th>Action</th>" : ""}</tr></thead><tbody>${payments.map((payment) => {
      const effect = D.transactionEffect(payment);
      const reversible = effect > 0 ? D.reversibleAmount(patient, payment.id) : 0;
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
        ${editable ? `<td>${reversible > D.EPSILON ? `<button class="btn btn-ghost btn-small" type="button" data-payments-action="transaction" data-transaction-id="${D.escapeHtml(payment.id)}">Correct</button>` : ""}</td>` : ""}
      </tr>`;
    }).join("")}</tbody></table></div>`;
  }

  function adjustmentHistoryHtml(patient) {
    const adjustments = D.normalizedAdjustments(patient).sort((a, b) => `${b.date}|${b.createdAt}`.localeCompare(`${a.date}|${a.createdAt}`));
    if (!adjustments.length) return '<div class="notes-box">No adjustments, write-offs, or financial-assistance entries.</div>';
    return `<div class="history-wrap"><table class="history-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reason</th></tr></thead><tbody>${adjustments.map((entry) => `<tr><td>${D.formatDate(entry.date)}</td><td>${D.escapeHtml(entry.type)}</td><td><strong>${D.currency.format(entry.amount)}</strong></td><td>${D.escapeHtml(entry.note)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function activityTimelineHtml(patient) {
    const activities = (patient.activity || []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!activities.length) return '<div class="notes-box">No activity has been recorded.</div>';
    return `<div class="activity-timeline">${activities.map((activity) => `
      <article class="activity-entry activity-${D.escapeHtml(activity.type)}">
        <div class="activity-marker" aria-hidden="true"></div>
        <div class="activity-content"><div class="activity-heading"><strong>${D.escapeHtml(activity.title)}</strong><time>${D.formatDateTime(activity.createdAt)}</time></div><p>${D.escapeHtml(activity.detail || "No additional detail.")}</p><span>${D.escapeHtml(activity.actor)}</span></div>
      </article>`).join("")}</div>`;
  }

  function planDetailsHtml(patient) {
    const summary = D.planSummary(patient);
    if (!summary) return "";
    const onTimeText = summary.onTimeRate === null ? "Not measured yet" : `${summary.onTimeRate.toFixed(1)}%`;
    return `
      <div class="detail-section" id="paymentPlanDetailsSection">
        <div class="detail-section-heading"><div><h3>Payment Schedule</h3><p>Read-only summary. Use Payments from the main board to edit the schedule or record a collection.</p></div>${statusPillsHtml(patient)}</div>
        <div class="details-summary plan-summary-cards plan-balance-cards">
          <div class="mini-card"><span>ACC overdue</span><strong>${summary.overdueCount}</strong></div>
          <div class="mini-card"><span>Due today</span><strong>${summary.dueTodayCount}</strong></div>
          <div class="mini-card"><span>UF checks due</span><strong>${summary.ufCheckDueCount}</strong></div>
          <div class="mini-card"><span>ACC on-time</span><strong>${onTimeText}</strong></div>
        </div>
        ${summary.ufCheckDueCount ? `<div class="uf-verification-callout"><strong>⚑ Check UF:</strong> ${summary.ufCheckDueCount} UF-assigned payment${summary.ufCheckDueCount === 1 ? " has" : "s have"} passed the due date without a UF payment in the ledger. Oldest: <strong>${summary.oldestUfCheckDays} day${summary.oldestUfCheckDays === 1 ? "" : "s"} past due</strong>.</div>` : ""}
        <div class="plan-detail-progress"><div class="plan-progress-heading"><span>${D.currency.format(summary.totalCollected)} collected</span><strong>${summary.progressPercent.toFixed(1)}%</strong></div><div class="progress-track"><div class="progress-fill health-progress" style="width:${summary.progressPercent.toFixed(2)}%"></div></div></div>
        <div class="history-wrap"><table class="history-table plan-history-table"><thead><tr><th>Payment</th><th>Due date</th><th>Assigned to</th><th>Assigned amount</th><th>Collected</th><th>Outstanding</th><th>Status</th></tr></thead><tbody>${summary.installments.map((installment) => {
          const mappedStatus = installment.status === "Upcoming" ? "Upcoming Collection" : installment.status;
          const meta = D.statusMeta(mappedStatus);
          return `<tr><td><strong>${installment.number}</strong></td><td>${D.formatDate(installment.dueDate)}</td><td><strong>${installment.responsibilityParty === "UF" ? "UF" : "ACC"}</strong></td><td>${D.currency.format(installment.amount)}</td><td>${D.currency.format(installment.paidAmount)}</td><td>${D.currency.format(installment.remaining)}</td><td><span class="status-pill ${meta.pill} compact">${D.escapeHtml(installment.status)}${installment.status === "Paid" && installment.onTime ? " · On time" : ""}</span>${installment.ufCheckDue ? `<div class="uf-check-inline-flag">⚑ ${installment.daysLate} day${installment.daysLate === 1 ? "" : "s"} past due</div>` : ""}</td></tr>`;
        }).join("")}</tbody></table></div>
      </div>`;
  }

  async function openDetailsDialog(patient, focus = "overview") {
    detailsPatientId = patient.id;
    detailsFocus = focus;
    const status = D.effectiveStatus(patient);
    document.getElementById("detailsTitle").textContent = patient.name;
    document.getElementById("detailsSubtitle").textContent = `${patient.mrn} · ${status} · Read-only summary`;
    document.getElementById("detailsBody").innerHTML = `
      ${paymentsFinancialSummaryHtml(patient)}
      <div class="detail-section">
        <h3>Account Overview</h3>
        <div class="detail-grid">
          <div class="detail-item"><span>Status</span><strong>${statusPillsHtml(patient)}</strong></div>
          <div class="detail-item"><span>Status / action note</span><strong>${D.escapeHtml(patient.statusNote || "-")}</strong></div>
          <div class="detail-item"><span>Arrangement</span><strong>${D.escapeHtml(D.arrangementFromLegacy(patient))}</strong></div>
          <div class="detail-item"><span>Next due / collection date</span><strong>${D.formatDate(D.nextActionDate(patient))} (${D.escapeHtml(dateRelativeText(D.nextActionDate(patient)))})</strong></div>
          <div class="detail-item"><span>Treatment flags</span><strong><span class="treatment-badges">${D.patientTreatments(patient).map((treatment) => `<span class="treatment-badge">${D.escapeHtml(treatment)}</span>`).join("")}</span></strong></div>
          <div class="detail-item"><span>Treatment site</span><strong>${D.escapeHtml(patient.location)}</strong></div>
          <div class="detail-item"><span>Insurance</span><strong>${D.escapeHtml(patient.insurance)}</strong></div>
          <div class="detail-item"><span>Account created</span><strong>${D.escapeHtml(D.formatDateTime(patient.createdAt))}</strong></div>
          <div class="detail-item"><span>Last updated</span><strong>${D.escapeHtml(D.formatDateTime(patient.updatedAt || patient.createdAt))}</strong></div>
        </div>
      </div>
      ${planDetailsHtml(patient)}
      <div class="detail-section"><h3>Finance Note</h3><div class="notes-box">${D.escapeHtml(patient.notes || "No finance note entered.")}</div>${patient.noResponsibilityReason ? `<div class="notes-box"><strong>No-responsibility reason:</strong> ${D.escapeHtml(patient.noResponsibilityReason)}</div>` : ""}</div>
      <div class="detail-section"><div class="detail-section-heading"><div><h3>Payment Ledger</h3><p>Read-only here. Use Payments from the main board for new records or corrections.</p></div></div>${paymentHistoryHtml(patient, false)}</div>
      <div class="detail-section"><div class="detail-section-heading"><div><h3>Adjustments</h3><p>Financial adjustments are shown for reference.</p></div></div>${adjustmentHistoryHtml(patient)}</div>
      <div class="detail-section activity-section" id="activityTimelineSection"><div class="detail-section-heading"><div><h3>Activity Timeline</h3><p>Chronological history of account, payment, plan, document, and completion activity.</p></div></div>${activityTimelineHtml(patient)}</div>
    `;

    const detailsBody = document.getElementById("detailsBody");
    // Dialog scroll position is preserved by browsers between openings. Always start
    // a normal View Details request at the top so the financial summary is never
    // clipped by the previous patient's scroll position.
    detailsBody.scrollTop = 0;
    if (!elements.detailsDialog.open) elements.detailsDialog.showModal();
    requestAnimationFrame(() => {
      detailsBody.scrollTop = 0;
      if (focus === "timeline") document.getElementById("activityTimelineSection")?.scrollIntoView({ block: "start" });
      if (focus === "plan") document.getElementById("paymentPlanDetailsSection")?.scrollIntoView({ block: "start" });
    });
  }

  function openCompletionDialog(patient) {
    const plan = planForPatient(patient);
    const outstanding = plan ? plan.totalOwed : D.amountOwed(patient);
    document.getElementById("completionPatientId").value = patient.id;
    document.getElementById("completionPatientLabel").textContent = `${patient.name} · ${patient.mrn}`;
    document.getElementById("completionReason").value = "";
    document.getElementById("completionNote").value = "";
    const callout = document.getElementById("completionBalanceCallout");
    callout.innerHTML = outstanding > D.EPSILON
      ? `<strong>${D.currency.format(outstanding)} remains outstanding.</strong> Completing the patient will remove them from the active board without changing the balance.`
      : `<strong>Balance is satisfied.</strong> Completing the patient will move them to Completed Patients.`;
    callout.classList.toggle("has-balance", outstanding > D.EPSILON);
    elements.completionDialog.showModal();
  }

  function completePatient(patient, reason, note = "") {
    const plan = planForPatient(patient);
    const outstanding = plan ? plan.totalOwed : D.amountOwed(patient);
    patient.archived = true;
    patient.completedAt = D.todayIso();
    patient.completionReason = String(reason || "");
    patient.completionNote = String(note || "");
    const balanceNote = outstanding > D.EPSILON
      ? ` Archived with ${D.currency.format(outstanding)} still outstanding.`
      : "";
    const noteText = note ? ` Note: ${note}` : "";
    D.addActivity(patient, {
      type: "completion",
      title: "Account completed and archived",
      detail: `Reason: ${reason}.${balanceNote}${noteText}`,
      date: D.todayIso()
    });
    D.savePatients(patients);
    if (elements.detailsDialog.open) elements.detailsDialog.close();
    if (elements.completionDialog.open) elements.completionDialog.close();
    render();
    showToast(`${patient.name} moved to Completed Patients${outstanding > D.EPSILON ? ` with ${D.currency.format(outstanding)} outstanding` : ""}.`);
  }

  // Form submissions --------------------------------------------------------
  document.getElementById("patientForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = document.getElementById("patientId").value;
    const existing = id ? findPatient(id) : null;
    const arrangement = document.getElementById("patientArrangement").value;
    let responsibility = Number(document.getElementById("patientResponsibility").value || 0);
    const openingCollected = existing ? D.netCollected(existing) : 0;

    if (!Number.isFinite(responsibility) || responsibility < 0) return showToast("Patient responsibility must be a valid nonnegative number.", "error");
    if (arrangement === "No Responsibility") responsibility = 0;
    if (arrangement === "No Responsibility" && existing && D.netCollected(existing) > D.EPSILON) return showToast("An account with payment history cannot be changed to No Patient Responsibility.", "error");

    const collectionDateInput = document.getElementById("patientDate").value;
    if (arrangement === "Payment Plan" && !validOperationalDate(collectionDateInput, "Collection date")) return;
    const noResponsibilityReason = document.getElementById("noResponsibilityReason").value.trim();
    if (arrangement === "No Responsibility" && !noResponsibilityReason) return showToast("A reason is required for No Patient Responsibility.", "error");

    let paymentPlan = null;
    let collectionDate = collectionDateInput;
    let planChanged = false;
    if (arrangement === "Payment Plan") {
      editingPlanSchedule = readPlanScheduleFromDom();
      const planOpeningCollected = 0;
      const invalidInstallment = editingPlanSchedule.some((installment) =>
        !installment.dueDate
        || !Number.isFinite(installment.amount)
        || installment.amount <= 0
        || !["Ackerman", "UF"].includes(installment.responsibilityParty)
        || !validOperationalDate(installment.dueDate, "Installment due date", false)
      );
      if (editingPlanSchedule.length < 1 || invalidInstallment) {
        return showToast("The payment plan needs at least one valid payment with a due date, amount, and Ackerman or UF responsibility selected.", "error");
      }

      paymentPlan = {
        createdDate: existing?.paymentPlan?.createdDate || D.todayIso(),
        openingCollected: planOpeningCollected,
        promiseToPayDate: existing?.paymentPlan?.promiseToPayDate || "",
        renegotiationCount: existing?.paymentPlan?.renegotiationCount || 0,
        history: D.deepCopy(existing?.paymentPlan?.history || []),
        installments: editingPlanSchedule.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      };
      collectionDate = paymentPlan.installments[0]?.dueDate || collectionDateInput;
      planChanged = Boolean(existing?.paymentPlan && planSnapshot(paymentPlan) !== originalPlanSnapshot);
      if (planChanged) {
        paymentPlan.renegotiationCount += 1;
        const ackermanCount = paymentPlan.installments.filter((item) => item.responsibilityParty !== "UF").length;
        const ufCount = paymentPlan.installments.filter((item) => item.responsibilityParty === "UF").length;
        paymentPlan.history.push({
          id: D.uid("plan-history"),
          date: D.todayIso(),
          reason: "Manual schedule update",
          detail: `${paymentPlan.installments.length} payment rows · ${ackermanCount} ACC responsible · ${ufCount} UF responsible.`,
          createdAt: new Date().toISOString()
        });
      }
    }

    const record = {
      id: id || D.uid("patient"),
      name: document.getElementById("patientName").value.trim(),
      mrn: document.getElementById("patientMrn").value.trim().toUpperCase(),
      location: document.getElementById("patientLocation").value,
      treatments: [...document.querySelectorAll('input[name="patientTreatmentFlag"]:checked')].map((checkbox) => checkbox.value),
      treatment: [...document.querySelectorAll('input[name="patientTreatmentFlag"]:checked')].map((checkbox) => checkbox.value).join(" · "),
      insurance: document.getElementById("patientInsurance").value.trim(),
      responsibility,
      collected: existing ? D.netCollected(existing) : 0,
      collectionDate,
      status: arrangement,
      arrangement,
      noResponsibilityReason,
      statusNote: document.getElementById("patientStatusNote").value.trim(),
      notes: document.getElementById("patientNotes").value.trim(),
      archived: existing ? existing.archived : false,
      completedAt: existing ? existing.completedAt : "",
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: existing?.updatedAt || new Date().toISOString(),
      paymentPlan,
      payments: existing ? D.deepCopy(existing.payments || []) : [],
      adjustments: existing ? D.deepCopy(existing.adjustments || []) : [],
      activity: existing ? D.deepCopy(existing.activity || []) : []
    };

    if (!record.name || !record.mrn || !record.insurance || !record.collectionDate) return showToast("Complete all required fields.", "error");
    if (!record.treatments.length) return showToast("Select at least one treatment flag.", "error");
    if (patients.some((patient) => patient.mrn.toLowerCase() === record.mrn.toLowerCase() && patient.id !== record.id)) return showToast("That MRN already exists.", "error");

    if (existing && Math.abs(Number(existing.responsibility || 0) - responsibility) > D.EPSILON && (existing.payments || []).length) {
      if (!window.confirm("This account already has payment history. Confirm the patient responsibility change.")) return;
    }
    if (!existing) {
      D.addActivity(record, { type: "account", title: "Patient account created", detail: `${arrangement} account with ${D.currency.format(responsibility)} responsibility.`, date: D.todayIso() });
    } else {
      const changes = [];
      ["name", "mrn", "location", "insurance", "collectionDate", "statusNote", "notes"].forEach((key) => {
        if (String(existing[key] || "") !== String(record[key] || "")) changes.push(key);
      });
      if (D.treatmentLabel(existing) !== record.treatment) changes.push("treatments");
      if (Math.abs(existing.responsibility - record.responsibility) > D.EPSILON) changes.push("responsibility");
      if (D.arrangementFromLegacy(existing) !== arrangement) changes.push("arrangement");
      if (changes.length) D.addActivity(record, { type: "account", title: "Account details updated", detail: `Changed: ${changes.join(", ")}.`, date: D.todayIso() });
      if (planChanged) D.addActivity(record, { type: "plan", title: "Payment plan schedule updated", detail: "Due dates, amounts, or ACC/UF responsibility assignments were changed.", date: D.todayIso() });
    }

    const normalized = D.normalizePatient(record);
    const index = patients.findIndex((patient) => patient.id === normalized.id);
    if (index >= 0) patients[index] = normalized; else patients.push(normalized);
    D.savePatients(patients);
    populateFilters();
    elements.patientDialog.close();
    render();
    showToast(existing ? `${record.name} updated.` : `${record.name} added to the board.`);
  });

  document.getElementById("paymentForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const patient = findPatient(document.getElementById("paymentPatientId").value);
    if (!patient) return showToast("The selected patient could not be found.", "error");
    const amount = Number(document.getElementById("paymentAmount").value);
    const date = document.getElementById("paymentDate").value;
    const username = document.getElementById("paymentUsername").value.trim();
    const officeSite = document.getElementById("paymentOfficeSite").value;
    const installmentId = document.getElementById("paymentInstallmentId").value;
    const responsibilityParty = document.getElementById("paymentResponsibilityParty").value === "UF" ? "UF" : "Ackerman";
    if (!validOperationalDate(date, "Payment date")) return;
    if (!Number.isFinite(amount) || amount <= 0) return showToast("Enter a collected amount greater than $0.00.", "error");
    if (!username) return showToast("Username / staff member is required.", "error");
    if (!officeSite) return showToast("Office site is required.", "error");

    D.addPaymentTransaction(patient, {
      type: "Payment", amount, date,
      location: patient.location, officeSite, username, responsibilityParty, installmentId,
      method: document.getElementById("paymentMethod").value,
      note: document.getElementById("paymentNote").value.trim(), appliesToPlan: true
    });
    const normalized = D.normalizePatient(patient);
    const index = patients.findIndex((item) => item.id === normalized.id);
    if (index >= 0) patients[index] = normalized;
    D.savePatients(patients);
    elements.paymentDialog.close();
    render();
    openPaymentsDialog(normalized);
    showToast(`${D.currency.format(amount)} ${responsibilityParty === "UF" ? "UF" : "ACC"} payment recorded for ${patient.name}.`);
  });


  document.getElementById("adjustmentForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const patient = findPatient(document.getElementById("adjustmentPatientId").value);
    if (!patient) return;
    const amount = Number(document.getElementById("adjustmentAmount").value);
    const balance = D.amountOwed(patient);
    const date = document.getElementById("adjustmentDate").value;
    const note = document.getElementById("adjustmentNote").value.trim();
    if (!validOperationalDate(date, "Adjustment date")) return;
    if (!Number.isFinite(amount) || amount <= 0 || amount > balance + D.EPSILON) return showToast(`Adjustment must be between $0.01 and ${D.currency.format(balance)}.`, "error");
    if (!note) return showToast("A reason is required for every financial adjustment.", "error");
    D.addAdjustment(patient, { type: document.getElementById("adjustmentType").value, amount, date, note });
    D.savePatients(patients);
    elements.adjustmentDialog.close();
    render();
    if (elements.detailsDialog.open) openDetailsDialog(patient);
    if (paymentsPatientId === patient.id) openPaymentsDialog(patient);
    showToast(`${D.currency.format(amount)} ${document.getElementById("adjustmentType").value.toLowerCase()} recorded for ${patient.name}.`);
  });

  document.getElementById("transactionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const patient = findPatient(document.getElementById("transactionPatientId").value);
    const original = patient && D.normalizedPayments(patient).find((transaction) => transaction.id === document.getElementById("transactionId").value);
    if (!patient || !original) return showToast("The selected transaction could not be found.", "error");
    const action = document.getElementById("transactionAction").value;
    const amount = Number(document.getElementById("transactionAmount").value);
    const available = D.reversibleAmount(patient, original.id);
    const date = document.getElementById("transactionDate").value;
    const reason = document.getElementById("transactionReason").value.trim();
    if (!validOperationalDate(date, "Correction date")) return;
    if (!Number.isFinite(amount) || amount <= 0 || amount > available + D.EPSILON) return showToast(`Enter an amount between $0.01 and ${D.currency.format(available)}.`, "error");
    if (!reason) return showToast("A reason is required.", "error");

    const shared = {
      date, location: original.location, officeSite: original.officeSite, username: original.username,
      responsibilityParty: original.responsibilityParty, installmentId: original.installmentId,
      appliesToPlan: original.appliesToPlan, relatedTransactionId: original.id
    };
    if (action === "Correction") {
      const correctedAmount = Number(document.getElementById("correctedAmount").value);
      if (!Number.isFinite(correctedAmount) || correctedAmount <= 0) return showToast("Corrected payment must be greater than $0.00.", "error");
      D.addPaymentTransaction(patient, { ...shared, type: "Correction Reversal", amount, method: original.method, note: reason }, false);
      D.addPaymentTransaction(patient, { ...shared, type: "Correction Payment", amount: correctedAmount, method: document.getElementById("correctedMethod").value, note: `Correction: ${reason}` }, false);
      D.addActivity(patient, { type: "payment", title: "Payment corrected", detail: `${D.currency.format(amount)} reversed and replaced with ${D.currency.format(correctedAmount)} · ${reason}`, date });
    } else {
      D.addPaymentTransaction(patient, { ...shared, type: action, amount, method: original.method, note: reason });
    }
    const normalized = D.normalizePatient(patient);
    const index = patients.findIndex((item) => item.id === normalized.id);
    if (index >= 0) patients[index] = normalized;
    D.savePatients(patients);
    elements.transactionDialog.close();
    render();
    openPaymentsDialog(normalized);
    showToast(`${action === "Correction" ? "Correction" : action} recorded for ${patient.name}.`);
  });

  // Event handlers ----------------------------------------------------------
  elements.tbody.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const patient = findPatient(button.dataset.id);
    if (!patient) return;
    if (button.dataset.action === "toggle-row") {
      if (collapsedPatientIds.has(patient.id)) collapsedPatientIds.delete(patient.id);
      else collapsedPatientIds.add(patient.id);
      renderRows();
      return;
    }
    if (button.dataset.action === "payments") openPaymentsDialog(patient);
    if (button.dataset.action === "details") openDetailsDialog(patient);
    if (button.dataset.action === "timeline") openDetailsDialog(patient, "timeline");
    if (button.dataset.action === "uf-check") openPaymentsDialog(patient);
    if (button.dataset.action === "edit") openPatientDialog(patient);
    if (button.dataset.action === "adjustment") openAdjustmentDialog(patient);
    if (button.dataset.action === "complete") openCompletionDialog(patient);
    if (button.dataset.action === "documents" && Docs) Docs.open(patient);
  });

  elements.tbody.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-status-note-id]");
    if (!input) return;
    const patient = findPatient(input.dataset.statusNoteId);
    if (!patient) return;
    const nextNote = input.value.trim();
    if (patient.statusNote === nextNote) return;
    patient.statusNote = nextNote;
    D.addActivity(patient, { type: "account", title: "Status note updated", detail: nextNote || "Status note cleared.", date: D.todayIso() });
    D.savePatients(patients);
    showToast(`Status note saved for ${patient.name}.`);
  });

  document.getElementById("paymentsScheduleBody").addEventListener("input", () => {
    const patient = findPatient(paymentsPatientId);
    if (!patient) return;
    paymentsScheduleDraft = readPaymentsScheduleDraft();
    refreshPaymentsScheduleSummary(patient);
  });

  document.getElementById("paymentsScheduleBody").addEventListener("change", () => {
    const patient = findPatient(paymentsPatientId);
    if (!patient) return;
    paymentsScheduleDraft = readPaymentsScheduleDraft();
    refreshPaymentsScheduleSummary(patient);
  });

  document.getElementById("paymentsScheduleBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-payments-action]");
    if (!button) return;
    const patient = findPatient(paymentsPatientId);
    if (!patient) return;
    paymentsScheduleDraft = readPaymentsScheduleDraft();
    const action = button.dataset.paymentsAction;
    const installmentId = button.dataset.installmentId;
    if (action === "record") {
      const savedSnapshot = paymentsScheduleSnapshot(patient.paymentPlan?.installments || []);
      if (paymentsScheduleSnapshot(paymentsScheduleDraft) !== savedSnapshot) return showToast("Save schedule changes before recording a payment.", "error");
      return openPaymentDialog(patient, installmentId);
    }
    if (action === "remove") {
      if (paymentsScheduleDraft.length <= 1) return showToast("A payment plan needs at least one scheduled payment.", "error");
      const hasLedger = D.normalizedPayments(patient).some((payment) => payment.installmentId === installmentId && Math.abs(D.transactionEffect(payment)) > D.EPSILON);
      if (hasLedger && !window.confirm("This scheduled payment has ledger activity. Removing the schedule row will keep those ledger entries as historical records. Continue?")) return;
      paymentsScheduleDraft = paymentsScheduleDraft.filter((item) => item.id !== installmentId);
      renderPaymentsWorkspace(patient);
    }
  });

  document.getElementById("paymentsLedger").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-payments-action='transaction']");
    if (!button) return;
    const patient = findPatient(paymentsPatientId);
    if (!patient) return;
    const transaction = D.normalizedPayments(patient).find((item) => item.id === button.dataset.transactionId);
    if (!transaction) return;
    if (elements.paymentsDialog.open) elements.paymentsDialog.close();
    openTransactionDialog(patient, transaction);
  });

  document.getElementById("addScheduledPaymentButton").addEventListener("click", () => {
    const patient = findPatient(paymentsPatientId);
    if (!patient) return;
    paymentsScheduleDraft = readPaymentsScheduleDraft();
    const last = paymentsScheduleDraft.slice().sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).at(-1);
    const f = D.financialBreakdown(patient);
    paymentsScheduleDraft.push({
      id: D.uid("installment"),
      dueDate: last?.dueDate ? D.addDays(last.dueDate, 30) : D.todayIso(),
      originalDueDate: last?.dueDate ? D.addDays(last.dueDate, 30) : D.todayIso(),
      amount: Math.max(0.01, f.totalOutstanding > 0 ? f.totalOutstanding : 0.01),
      responsibilityParty: "Ackerman", ufVerified: false, ufVerifiedAt: "", rescheduledAt: "", isNew: true
    });
    renderPaymentsWorkspace(patient);
  });

  document.getElementById("savePaymentScheduleButton").addEventListener("click", () => {
    const patient = findPatient(paymentsPatientId);
    if (!patient) return;
    paymentsScheduleDraft = readPaymentsScheduleDraft();
    if (!paymentsScheduleDraft.length) return showToast("A payment plan needs at least one scheduled payment.", "error");
    for (const installment of paymentsScheduleDraft) {
      if (!validOperationalDate(installment.dueDate, "Scheduled payment due date")) return;
      if (!Number.isFinite(installment.amount) || installment.amount <= 0) return showToast("Every scheduled payment needs an amount greater than $0.00.", "error");
    }
    const previous = patient.paymentPlan || { createdDate: D.todayIso(), openingCollected: 0, renegotiationCount: 0, history: [] };
    patient.paymentPlan = {
      createdDate: previous.createdDate || D.todayIso(), openingCollected: 0, promiseToPayDate: "",
      renegotiationCount: Number(previous.renegotiationCount || 0) + 1,
      history: [...(previous.history || []), { id: D.uid("plan-history"), date: D.todayIso(), reason: "Payment schedule updated", detail: `${paymentsScheduleDraft.length} scheduled payments · edited from Payments workspace.`, createdAt: new Date().toISOString() }],
      installments: paymentsScheduleDraft.map(({ isNew, ...item }) => ({ ...item, ufVerified: false, ufVerifiedAt: "" })).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    };
    patient.collectionDate = patient.paymentPlan.installments[0]?.dueDate || patient.collectionDate;
    D.addActivity(patient, { type: "plan", title: "Payment schedule updated", detail: `${patient.paymentPlan.installments.length} scheduled payments. Assigned totals were updated without changing Total Patient Responsibility.`, date: D.todayIso() });
    const normalized = D.normalizePatient(patient);
    const index = patients.findIndex((item) => item.id === normalized.id);
    if (index >= 0) patients[index] = normalized;
    D.savePatients(patients);
    populateFilters();
    render();
    openPaymentsDialog(normalized);
    showToast(`Payment schedule saved for ${normalized.name}.`);
  });

  document.getElementById("paymentsAdjustmentButton").addEventListener("click", () => {
    const patient = findPatient(paymentsPatientId);
    if (!patient) return;
    if (elements.paymentsDialog.open) elements.paymentsDialog.close();
    openAdjustmentDialog(patient);
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

  document.getElementById("detailsPrintButton").addEventListener("click", () => {
    const patient = findPatient(detailsPatientId);
    if (patient) printSummary(patient);
  });

  document.getElementById("completionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const patient = findPatient(document.getElementById("completionPatientId").value);
    if (!patient) return showToast("The selected patient could not be found.", "error");
    const reason = document.getElementById("completionReason").value;
    const note = document.getElementById("completionNote").value.trim();
    if (!reason) return showToast("Choose a completion reason.", "error");
    if (reason === "Other" && !note) return showToast("Add a short completion note when Other is selected.", "error");
    completePatient(patient, reason, note);
  });
  document.getElementById("cancelCompletionButton").addEventListener("click", () => elements.completionDialog.close());

  document.getElementById("addPatientButton").addEventListener("click", () => openPatientDialog());
  document.getElementById("patientArrangement").addEventListener("change", () => toggleArrangementSection({ autoBuild: true }));
  document.getElementById("buildPlanButton").addEventListener("click", buildPlanSchedule);
  elements.planScheduleBody.addEventListener("input", () => {
    updatePlanEditorSummary();
  });
  elements.planScheduleBody.addEventListener("change", () => {
    updatePlanEditorSummary();
  });
  document.getElementById("patientResponsibility").addEventListener("input", updatePlanEditorSummary);

  document.getElementById("adjustmentAmount").addEventListener("input", () => {
    const patient = findPatient(document.getElementById("adjustmentPatientId").value);
    const amount = Number(document.getElementById("adjustmentAmount").value || 0);
    document.getElementById("adjustmentAfter").textContent = D.currency.format(Math.max(0, (patient ? D.amountOwed(patient) : 0) - amount));
  });
  document.getElementById("transactionAction").addEventListener("change", toggleCorrectionFields);

  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => document.getElementById(button.dataset.close).close()));
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog && dialog.id !== "patientDialog") dialog.close();
  }));
  elements.patientDialog.addEventListener("cancel", (event) => event.preventDefault());

  [elements.search, elements.locationFilter, elements.treatmentFilter]
    .forEach((control) => control.addEventListener("input", () => { quickFilter = ""; render(); }));
  elements.statusFilter.addEventListener("input", () => {
    quickFilter = "";
    if (elements.statusFilter.value === "UF Check Due") {
      elements.sort.value = "ufCheckAge:desc";
      sortState = parseSortValue(elements.sort.value);
    }
    render();
  });
  elements.sort.addEventListener("change", () => { sortState = parseSortValue(elements.sort.value); render(); });
  document.querySelectorAll(".sort-button").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.sortKey;
    if (sortState.key === key) sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
    else { sortState.key = key; sortState.direction = ["owed", "responsibility", "collected", "planProgress"].includes(key) ? "desc" : "asc"; }
    const value = `${sortState.key}:${sortState.direction}`;
    if ([...elements.sort.options].some((item) => item.value === value)) elements.sort.value = value;
    render();
  }));

  document.querySelectorAll("[data-quick-filter]").forEach((button) => button.addEventListener("click", () => {
    quickFilter = quickFilter === button.dataset.quickFilter ? "" : button.dataset.quickFilter;
    render();
    document.getElementById("workQueueHeading").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.getElementById("clearQuickFilterButton").addEventListener("click", () => { quickFilter = ""; render(); });

  document.getElementById("clearFiltersButton").addEventListener("click", () => {
    elements.search.value = ""; elements.statusFilter.value = "all"; elements.locationFilter.value = "all"; elements.treatmentFilter.value = "all"; quickFilter = ""; render();
  });

  if (elements.toggleAllRowsButton) {
    elements.toggleAllRowsButton.addEventListener("click", () => {
      const visible = filteredPatients();
      const allCollapsed = visible.length > 0 && visible.every((patient) => collapsedPatientIds.has(patient.id));
      visible.forEach((patient) => {
        if (allCollapsed) collapsedPatientIds.delete(patient.id);
        else collapsedPatientIds.add(patient.id);
      });
      renderRows();
    });
  }

  elements.savedViewSelect.addEventListener("change", () => {
    const view = D.loadSavedViews("board").find((item) => item.id === elements.savedViewSelect.value);
    document.getElementById("deleteViewButton").disabled = !view;
    if (view) { elements.savedViewName.value = view.name; applyViewSettings(view.settings); }
  });
  document.getElementById("saveViewButton").addEventListener("click", () => {
    const name = elements.savedViewName.value.trim();
    if (!name) return showToast("Enter a name for the saved view.", "error");
    const existingId = elements.savedViewSelect.value;
    const record = D.saveSavedView("board", { id: existingId || undefined, name, settings: captureViewSettings() });
    renderSavedViews(record.id);
    showToast(`Saved view “${name}”.`);
  });
  document.getElementById("deleteViewButton").addEventListener("click", () => {
    const id = elements.savedViewSelect.value;
    if (!id) return;
    const name = elements.savedViewSelect.selectedOptions[0]?.textContent || "this view";
    if (!window.confirm(`Delete saved view "${name}"?`)) return;
    D.deleteSavedView("board", id);
    elements.savedViewName.value = "";
    renderSavedViews();
    showToast("Saved view deleted.");
  });

  document.getElementById("exportButton").addEventListener("click", () => {
    const visiblePatients = filteredPatients();
    if (!visiblePatients.length) return showToast("No visible records to export.", "error");
    if (!window.AckermanExcel) return showToast("Excel export could not be loaded.", "error");

    const headers = [
      "Status", "Payment Attention", "Status Note", "Patient Name", "MRN", "Treatment Site", "Treatment Flags", "Insurance",
      "Total Patient Responsibility", "Collected Total Patient Responsibility", "Outstanding Total Patient Responsibility",
      "ACC Assigned Patient Responsibility", "Collected ACC Assigned Patient Responsibility", "Outstanding ACC Assigned Patient Responsibility",
      "UF Assigned Patient Responsibility", "Collected UF Assigned Patient Responsibility", "Outstanding UF Assigned Patient Responsibility",
      "Adjustments", "Next Due Date", "Plan Payments", "Plan Payments Completed", "ACC Overdue Payments", "UF Checks Due", "Oldest UF Check Days", "Plan On-Time Rate", "Account Created", "Last Updated"
    ];
    const rows = visiblePatients.map((patient) => {
      const plan = D.planSummary(patient);
      const f = D.financialBreakdown(patient);
      return [
        frontPageStatus(patient), D.attentionStatus(patient), patient.statusNote || "", patient.name, patient.mrn, patient.location, D.treatmentLabel(patient), patient.insurance,
        f.totalAssigned, f.totalCollected, f.totalOutstanding,
        f.accAssigned, f.accCollected, f.accOutstanding,
        f.ufAssigned, f.ufCollected, f.ufOutstanding,
        f.adjustments, D.nextActionDate(patient), plan?.totalCount || 0, plan?.completedCount || 0, plan?.overdueCount || 0, plan?.ufCheckDueCount || 0, plan?.oldestUfCheckDays || 0,
        plan?.onTimeRate === null || !plan ? "" : plan.onTimeRate / 100, patient.createdAt || "", patient.updatedAt || ""
      ];
    });

    const types = [
      "text", "text", "wrap", "text", "text", "text", "wrap", "text",
      "currency", "currency", "currency", "currency", "currency", "currency", "currency", "currency", "currency", "currency", "date",
      "integer", "integer", "integer", "integer", "integer", "percent", "datetime", "datetime"
    ];
    const now = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
    window.AckermanExcel.exportWorkbook({
      filename: `ackerman-active-current-view-${D.todayIso()}.xlsx`,
      sheetName: "Active Patients",
      title: "Ackerman Patient Payment Board - Active Patients",
      subtitle: `${rows.length} visible ${rows.length === 1 ? "record" : "records"} · Exported ${now}`,
      headers, rows, types, statusColumn: 0, flagColumns: [22]
    });
    showToast(`${rows.length} visible ${rows.length === 1 ? "record" : "records"} exported to Excel.`);
  });

  document.addEventListener("ackerman-docs-changed", (event) => {
    const patientId = event.detail?.patientId;
    if (!patientId) return;
    document.querySelectorAll(`[data-doc-count-for="${CSS.escape(patientId)}"]`).forEach((badge) => {
      const count = Number(event.detail?.count || 0); badge.textContent = count; badge.hidden = count === 0;
    });
  });
  document.addEventListener("ackerman-document-event", (event) => {
    const patient = findPatient(event.detail?.patientId);
    if (!patient) return;
    const action = event.detail.action === "deleted" ? "Document deleted" : "Document attached";
    D.addActivity(patient, { type: "document", title: action, detail: event.detail.name || "Document", date: D.todayIso() });
    D.savePatients(patients);
    if (elements.detailsDialog.open && detailsPatientId === patient.id) openDetailsDialog(patient, detailsFocus);
  });

  // Version 3.3: changes saved on other workstations arrive here without a refresh.
  document.addEventListener("ackerman-remote-change", (event) => {
    D.applyPatientUpdates(patients, event.detail?.patients || [], event.detail?.removed);
    populateFilters();
    render();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === D.STORAGE_KEY) { patients = D.loadPatients(); populateFilters(); render(); }
    if (event.key === D.SAVED_VIEWS_KEY) renderSavedViews();
  });

  populateFilters();
  renderSavedViews();
  render();
})();
