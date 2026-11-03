(function () {
  "use strict";

  const D = window.AckermanData;
  if (!D) {
    throw new Error("AckermanData failed to load.");
  }

  let patients = D.loadPatients();
  let breakdownSort = { key: "outstanding", direction: "desc" };

  const chartColors = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-6)"
  ];

  const elements = {
    fromDate: document.getElementById("fromDate"),
    toDate: document.getElementById("toDate"),
    location: document.getElementById("analyticsLocationFilter"),
    treatment: document.getElementById("analyticsTreatmentFilter"),
    status: document.getElementById("analyticsStatusFilter"),
    groupBy: document.getElementById("groupBySelect"),
    breakdownSort: document.getElementById("breakdownSortSelect"),
    breakdownBody: document.getElementById("breakdownTableBody"),
    analysisEmpty: document.getElementById("analysisEmpty"),
    planPerformanceBody: document.getElementById("planPerformanceBody"),
    planPerformanceEmpty: document.getElementById("planPerformanceEmpty"),
    savedViewSelect: document.getElementById("analyticsSavedViewSelect"),
    savedViewName: document.getElementById("analyticsSavedViewName"),
    toastRegion: document.getElementById("toastRegion")
  };

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function toIsoLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function daysAgoIso(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return toIsoLocal(date);
  }

  function formatCompactCurrency(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value || 0);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
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
    setSelectOptions(elements.location, locations, "All locations");
    setSelectOptions(elements.treatment, treatments, "All treatments");
  }

  function matchesAnalyticsStatus(patient) {
    const selected = elements.status.value;
    if (selected === "all") return true;
    const status = D.effectiveStatus(patient);
    const attention = D.attentionStatus(patient);
    const plan = status === "Payment Plan" ? D.planSummary(patient) : null;
    if (selected === "Partial Overdue") return status === "Partially Paid" && attention === "Overdue";
    if (selected === "Partial Due Today") return status === "Partially Paid" && attention === "Due Today";
    if (selected === "Plan Overdue") return status === "Payment Plan" && (plan?.overdueCount || 0) > 0;
    if (selected === "Plan Due Today") return status === "Payment Plan" && (plan?.dueTodayCount || 0) > 0;
    if (selected === "Plan On Schedule") return status === "Payment Plan" && (plan?.overdueCount || 0) === 0;
    if (selected === "UF Check Due") return status === "Payment Plan" && (plan?.ufCheckDueCount || 0) > 0;
    if (selected === "Overdue") return attention === "Overdue" || (status === "Payment Plan" && (plan?.overdueCount || 0) > 0);
    if (selected === "Due Today") return attention === "Due Today" || (status === "Payment Plan" && (plan?.dueTodayCount || 0) > 0);
    return status === selected;
  }

  function filteredPatients() {
    const from = elements.fromDate.value;
    const to = elements.toDate.value;

    return patients.filter((patient) => {
      const date = patient.collectionDate || "";
      const matchesFrom = !from || date >= from;
      const matchesTo = !to || date <= to;
      const matchesLocation = elements.location.value === "all" || patient.location === elements.location.value;
      const matchesTreatment = elements.treatment.value === "all" || D.patientTreatments(patient).includes(elements.treatment.value);
      return matchesFrom && matchesTo && matchesLocation && matchesTreatment && matchesAnalyticsStatus(patient);
    });
  }

  function eligiblePatients(selected) {
    return selected.filter((patient) => D.effectiveStatus(patient) !== "No Responsibility" && Number(patient.responsibility || 0) > 0);
  }

  function paymentsFor(selected, { positiveOnly = false } = {}) {
    const transactions = selected.flatMap((patient) =>
      D.normalizedPayments(patient).map((payment) => ({
        ...payment,
        effect: D.transactionEffect(payment),
        patientId: patient.id,
        patientName: patient.name
      }))
    );
    return positiveOnly ? transactions.filter((payment) => payment.effect > 0) : transactions;
  }

  function renderKpis(selected) {
    const eligible = eligiblePatients(selected);
    const ledger = paymentsFor(selected);
    const payments = paymentsFor(selected, { positiveOnly: true });
    const responsibility = eligible.reduce((sum, patient) => sum + Number(patient.responsibility || 0), 0);
    const collected = eligible.reduce((sum, patient) => sum + D.netCollected(patient), 0);
    const adjustments = eligible.reduce((sum, patient) => sum + D.adjustmentTotal(patient), 0);
    const adjustmentCount = eligible.reduce((sum, patient) => sum + D.normalizedAdjustments(patient).length, 0);
    const outstanding = eligible.reduce((sum, patient) => sum + D.amountOwed(patient), 0);
    const paying = eligible.filter((patient) => D.netCollected(patient) > 0);
    const paid = eligible.filter((patient) => D.amountOwed(patient) <= 0);
    const openBalances = eligible.filter((patient) => D.amountOwed(patient) > 0).length;
    const rate = responsibility > 0 ? (collected / responsibility) * 100 : 0;
    const participation = eligible.length > 0 ? (paying.length / eligible.length) * 100 : 0;
    const paidRate = eligible.length > 0 ? (paid.length / eligible.length) * 100 : 0;
    const average = paying.length > 0 ? collected / paying.length : 0;
    const medianAmount = median(payments.map((payment) => payment.amount));
    const planSummaries = selected.map((patient) => ({ patient, summary: D.planSummary(patient) })).filter((item) => item.summary);
    const dueInstallments = planSummaries.reduce((sum, item) => sum + item.summary.dueCount, 0);
    const onTimeInstallments = planSummaries.reduce((sum, item) => sum + item.summary.onTimeCount, 0);
    const planOnTimeRate = dueInstallments > 0 ? (onTimeInstallments / dueInstallments) * 100 : 0;
    const plansNeedingAttention = planSummaries.filter((item) => item.summary.overdueCount > 0 || item.summary.dueTodayCount > 0 || item.summary.ufCheckDueCount > 0);
    const planPastDue = planSummaries.reduce((sum, item) => sum + item.summary.overdueAmount, 0);
    const criticalPatientCount = planSummaries.filter((item) => item.summary.overdueCount >= 2).length;
    const ufCheckCount = planSummaries.reduce((sum, item) => sum + item.summary.ufCheckDueCount, 0);

    document.getElementById("totalResponsibility").textContent = D.currency.format(responsibility);
    document.getElementById("responsibilitySubtext").textContent = `${eligible.length} eligible ${eligible.length === 1 ? "account" : "accounts"}`;
    document.getElementById("totalCollected").textContent = D.currency.format(collected);
    document.getElementById("collectedSubtext").textContent = `${ledger.length} ledger ${ledger.length === 1 ? "entry" : "entries"}`;
    document.getElementById("totalOutstanding").textContent = D.currency.format(outstanding);
    document.getElementById("outstandingSubtext").textContent = `${openBalances} open ${openBalances === 1 ? "balance" : "balances"}`;
    document.getElementById("collectionRateKpi").textContent = `${rate.toFixed(1)}%`;
    document.getElementById("payingPatients").textContent = paying.length.toLocaleString();
    document.getElementById("participationRate").textContent = `${participation.toFixed(1)}% participation`;
    document.getElementById("paidInFull").textContent = paid.length.toLocaleString();
    document.getElementById("paidInFullRate").textContent = `${paidRate.toFixed(1)}% of eligible accounts`;
    document.getElementById("averageCollected").textContent = D.currency.format(average);
    document.getElementById("medianPayment").textContent = D.currency.format(medianAmount);
    document.getElementById("paymentCountSubtext").textContent = `${payments.length} payment ${payments.length === 1 ? "transaction" : "transactions"}`;
    document.getElementById("planOnTimeRate").textContent = `${planOnTimeRate.toFixed(1)}%`;
    document.getElementById("planInstallmentSubtext").textContent = `${dueInstallments} due ${dueInstallments === 1 ? "installment" : "installments"}`;
    document.getElementById("plansNeedingAttention").textContent = plansNeedingAttention.length.toLocaleString();
    document.getElementById("planPastDueSubtext").textContent = `${D.currency.format(planPastDue)} past due`;
    document.getElementById("totalAdjustments").textContent = D.currency.format(adjustments);
    document.getElementById("adjustmentCountSubtext").textContent = `${adjustmentCount} ${adjustmentCount === 1 ? "entry" : "entries"}`;
    document.getElementById("criticalPatientCount").textContent = criticalPatientCount.toLocaleString();
    document.getElementById("ufCheckCount").textContent = ufCheckCount.toLocaleString();
  }

  function renderMonthlyChart(selected) {
    const container = document.getElementById("monthlyChart");
    const grouped = new Map();

    paymentsFor(selected).forEach((payment) => {
      const month = String(payment.date || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return;
      grouped.set(month, (grouped.get(month) || 0) + Number(payment.effect || 0));
    });

    const entries = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-8);

    if (!entries.length) {
      container.innerHTML = '<div class="chart-empty">No recorded payment transactions for this selection.</div>';
      return;
    }

    const max = Math.max(...entries.map(([, amount]) => amount), 1);
    const bars = entries.map(([month, amount]) => {
      const height = Math.max(2, (amount / max) * 100);
      return `
        <div class="vertical-bar-item" title="${D.escapeHtml(D.formatMonth(month))}: ${D.currency.format(amount)}">
          <div class="vertical-bar-value">${D.escapeHtml(formatCompactCurrency(amount))}</div>
          <div class="vertical-bar-track"><div class="vertical-bar-fill" style="height: ${height.toFixed(2)}%"></div></div>
          <div class="vertical-bar-label">${D.escapeHtml(D.formatMonth(month))}</div>
        </div>
      `;
    }).join("");

    container.innerHTML = `<div class="vertical-bars" style="--bar-count: ${entries.length}">${bars}</div>`;
  }

  function renderStatusChart(selected) {
    const container = document.getElementById("statusChart");
    const grouped = new Map();

    selected.forEach((patient) => {
      const owed = D.amountOwed(patient);
      if (owed <= 0) return;
      const status = D.effectiveStatus(patient);
      grouped.set(status, (grouped.get(status) || 0) + owed);
    });

    const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      container.innerHTML = '<div class="chart-empty">No outstanding balances for this selection.</div>';
      return;
    }

    const max = Math.max(...entries.map(([, amount]) => amount), 1);
    const rows = entries.map(([status, amount]) => {
      const meta = D.statusMeta(status);
      const width = (amount / max) * 100;
      const color = {
        overdue: "var(--overdue-accent)",
        due: "var(--due-accent)",
        ready: "var(--ready-accent)",
        partial: "var(--partial-accent)",
        plan: "var(--success)",
        paid: "var(--paid-accent)",
        none: "var(--none-accent)"
      }[meta.pill];
      return `
        <div class="horizontal-bar-item">
          <div class="horizontal-bar-label">${D.escapeHtml(status)}</div>
          <div class="horizontal-bar-track"><div class="horizontal-bar-fill" style="width: ${width.toFixed(2)}%; background: ${color}"></div></div>
          <div class="horizontal-bar-value">${D.currency.format(amount)}</div>
        </div>
      `;
    }).join("");

    container.innerHTML = `<div class="horizontal-bars">${rows}</div>`;
  }

  function summarizeBy(selected, key) {
    const grouped = new Map();

    const addPatient = (patient, groupName) => {
      if (!grouped.has(groupName)) {
        grouped.set(groupName, { name: groupName, patients: 0, paying: 0, responsibility: 0, collected: 0, outstanding: 0, rate: 0 });
      }
      const row = grouped.get(groupName);
      const eligible = D.effectiveStatus(patient) !== "No Responsibility" && Number(patient.responsibility || 0) > 0;
      row.patients += 1;
      if (eligible) {
        row.responsibility += Number(patient.responsibility || 0);
        row.collected += D.netCollected(patient);
        row.outstanding += D.amountOwed(patient);
        if (D.netCollected(patient) > 0) row.paying += 1;
      }
    };

    selected.forEach((patient) => {
      const groupNames = key === "treatment"
        ? D.patientTreatments(patient)
        : [key === "status" ? D.effectiveStatus(patient) : (patient[key] || "Not entered")];
      groupNames.forEach((groupName) => addPatient(patient, groupName));
    });

    grouped.forEach((row) => {
      row.rate = row.responsibility > 0 ? (row.collected / row.responsibility) * 100 : 0;
    });
    return [...grouped.values()];
  }

  function renderLocationChart(selected) {
    const container = document.getElementById("locationChart");
    const rows = summarizeBy(selected, "location")
      .filter((row) => row.responsibility > 0)
      .sort((a, b) => b.rate - a.rate);

    if (!rows.length) {
      container.innerHTML = '<div class="chart-empty">No eligible patient responsibility for this selection.</div>';
      return;
    }

    const html = rows.map((row, index) => `
      <div class="horizontal-bar-item">
        <div class="horizontal-bar-label" title="${D.escapeHtml(row.name)}">${D.escapeHtml(row.name)}</div>
        <div class="horizontal-bar-track"><div class="horizontal-bar-fill" style="width: ${Math.min(100, row.rate).toFixed(2)}%; background: ${chartColors[index % chartColors.length]}"></div></div>
        <div class="horizontal-bar-value">${row.rate.toFixed(1)}%</div>
      </div>
    `).join("");

    container.innerHTML = `<div class="horizontal-bars">${html}</div>`;
  }

  function renderMethodChart(selected) {
    const container = document.getElementById("methodChart");
    const grouped = new Map();

    paymentsFor(selected, { positiveOnly: true }).forEach((payment) => {
      const method = payment.method || "Other";
      grouped.set(method, (grouped.get(method) || 0) + Number(payment.amount || 0));
    });

    const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, amount]) => sum + amount, 0);

    if (!entries.length || total <= 0) {
      container.innerHTML = '<div class="chart-empty">No payment methods are available for this selection.</div>';
      return;
    }

    let start = 0;
    const segments = entries.map(([, amount], index) => {
      const end = start + (amount / total) * 100;
      const segment = `${chartColors[index % chartColors.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
      start = end;
      return segment;
    });

    const legend = entries.map(([method, amount], index) => {
      const percentage = (amount / total) * 100;
      return `
        <div class="legend-item">
          <span class="legend-swatch" style="background: ${chartColors[index % chartColors.length]}"></span>
          <span>${D.escapeHtml(method)} <small>(${percentage.toFixed(1)}%)</small></span>
          <strong>${D.currency.format(amount)}</strong>
        </div>
      `;
    }).join("");

    container.innerHTML = `
      <div class="donut-layout">
        <div class="donut" style="background: conic-gradient(${segments.join(", ")})">
          <div class="donut-center"><strong>${formatCompactCurrency(total)}</strong><span>collected</span></div>
        </div>
        <div class="legend">${legend}</div>
      </div>
    `;
  }

  function compareBreakdown(a, b) {
    let result;
    if (breakdownSort.key === "name") {
      result = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    } else {
      result = Number(a[breakdownSort.key] || 0) - Number(b[breakdownSort.key] || 0);
    }
    return breakdownSort.direction === "desc" ? -result : result;
  }

  function updateBreakdownSortIndicators() {
    document.querySelectorAll(".breakdown-sort").forEach((button) => {
      const active = button.dataset.sortKey === breakdownSort.key;
      button.querySelector(".sort-indicator").textContent = active
        ? (breakdownSort.direction === "asc" ? "▲" : "▼")
        : "";
    });
  }

  function syncBreakdownSortSelect() {
    elements.breakdownSort.querySelectorAll("option[data-temporary]").forEach((option) => option.remove());
    const value = `${breakdownSort.key}:${breakdownSort.direction}`;
    let option = [...elements.breakdownSort.options].find((item) => item.value === value);
    if (!option) {
      const labels = {
        name: "Group name",
        patients: "Patient count",
        paying: "Patients paying",
        responsibility: "Responsibility",
        collected: "Collected",
        outstanding: "Outstanding",
        rate: "Collection rate"
      };
      option = document.createElement("option");
      option.value = value;
      option.dataset.temporary = "true";
      option.textContent = `${labels[breakdownSort.key]}: ${breakdownSort.direction === "asc" ? "lowest / A-Z" : "highest / Z-A"}`;
      elements.breakdownSort.appendChild(option);
    }
    elements.breakdownSort.value = value;
  }

  function currentBreakdown(selected) {
    return summarizeBy(selected, elements.groupBy.value).sort(compareBreakdown);
  }

  function renderBreakdown(selected) {
    const rows = currentBreakdown(selected);
    elements.breakdownBody.innerHTML = "";
    elements.analysisEmpty.hidden = rows.length > 0;
    document.querySelector(".breakdown-table").hidden = rows.length === 0;

    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="Group"><strong>${D.escapeHtml(row.name)}</strong></td>
        <td class="numeric" data-label="Patients">${row.patients.toLocaleString()}</td>
        <td class="numeric" data-label="Paying">${row.paying.toLocaleString()}</td>
        <td class="numeric" data-label="Responsibility">${D.currency.format(row.responsibility)}</td>
        <td class="numeric" data-label="Collected">${D.currency.format(row.collected)}</td>
        <td class="numeric" data-label="Outstanding"><strong>${D.currency.format(row.outstanding)}</strong></td>
        <td class="numeric" data-label="Rate">
          <div class="rate-cell">
            <div class="rate-track"><div class="rate-fill" style="width: ${Math.min(100, row.rate).toFixed(2)}%"></div></div>
            <strong>${row.rate.toFixed(1)}%</strong>
          </div>
        </td>
      `;
      elements.breakdownBody.appendChild(tr);
    });

    updateBreakdownSortIndicators();
  }


  function planStatusPills(patient, summary) {
    const healthClass = summary.health === "red" ? "health-red" : (summary.health === "yellow" ? "health-yellow" : "health-green");
    const pills = [`<span class="status-pill ${healthClass}">Payment Plan</span>`];
    if (summary.overdueCount >= 2) pills.push(`<span class="status-pill health-red">${summary.overdueCount} payments overdue</span>`);
    else if (summary.overdueCount === 1) pills.push('<span class="status-pill health-yellow">1 payment overdue</span>');
    else pills.push('<span class="status-pill health-green">On Track</span>');
    if (summary.ufCheckDueCount > 0) pills.push(`<span class="status-pill uf-flag">${summary.ufCheckDueCount} UF check${summary.ufCheckDueCount === 1 ? "" : "s"} due</span>`);
    return `<div class="status-stack">${pills.join("")}</div>`;
  }

  function renderPlanPerformance(selected) {
    const rows = selected
      .map((patient) => ({ patient, summary: D.planSummary(patient) }))
      .filter((item) => item.summary)
      .sort((a, b) => {
        const healthRank = { red: 0, yellow: 1, green: 2 };
        const urgency = (healthRank[a.summary.health] ?? 9) - (healthRank[b.summary.health] ?? 9);
        if (urgency !== 0) return urgency;
        if (b.summary.overdueAmount !== a.summary.overdueAmount) return b.summary.overdueAmount - a.summary.overdueAmount;
        return a.patient.name.localeCompare(b.patient.name);
      });

    elements.planPerformanceBody.innerHTML = "";
    elements.planPerformanceEmpty.hidden = rows.length > 0;
    document.querySelector(".plan-performance-table").hidden = rows.length === 0;

    rows.forEach(({ patient, summary }) => {
      const onTime = summary.onTimeRate === null ? "Not due yet" : `${summary.onTimeRate.toFixed(1)}%`;
      const nextDue = summary.nextDue
        ? `${D.formatDate(summary.nextDue.dueDate)} · ${summary.nextDue.responsibilityParty === "UF" ? "UF" : "ACC"} · ${D.currency.format(summary.nextDue.amountDue)}`
        : "Plan complete";
      const terms = [`${summary.ackermanCount} ACC / ${summary.ufCount} UF`, summary.ufCheckDueCount ? `${summary.ufCheckDueCount} UF check due` : "", summary.repeatedMisses ? "Red status" : ""].filter(Boolean).join(" · ");
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="Patient"><strong>${D.escapeHtml(patient.name)}</strong><div class="mrn">${D.escapeHtml(patient.mrn)}</div></td>
        <td data-label="Plan Status">${planStatusPills(patient, summary)}</td>
        <td data-label="Progress">
          <div class="cell-primary">${summary.completedCount} of ${summary.totalCount} installments</div>
          <div class="progress-track compact-progress"><div class="progress-fill health-progress" style="width:${summary.progressPercent.toFixed(2)}%"></div></div>
          <div class="cell-secondary">${summary.progressPercent.toFixed(1)}% of plan paid · ${D.escapeHtml(terms)}</div>
        </td>
        <td data-label="Next Due">${D.escapeHtml(nextDue)}</td>
        <td class="numeric" data-label="Past Due"><strong>${D.currency.format(summary.overdueAmount)}</strong></td>
        <td class="numeric" data-label="On-Time Rate">${D.escapeHtml(onTime)}</td>
        <td class="numeric" data-label="Still Owed">${D.currency.format(D.amountOwed(patient))}</td>
      `;
      elements.planPerformanceBody.appendChild(tr);
    });
  }

  function renderInsights(selected) {
    const locations = summarizeBy(selected, "location").filter((row) => row.responsibility > 0);
    const best = [...locations].sort((a, b) => b.rate - a.rate)[0];
    const largestLocation = [...locations].sort((a, b) => b.outstanding - a.outstanding)[0];
    const overdue = selected.filter((patient) => {
      const plan = D.effectiveStatus(patient) === "Payment Plan" ? D.planSummary(patient) : null;
      return D.attentionStatus(patient) === "Overdue" || (plan?.overdueCount || 0) > 0;
    });
    const overdueAmount = overdue.reduce((sum, patient) => sum + D.amountOwed(patient), 0);
    const largestPatient = [...selected]
      .filter((patient) => D.amountOwed(patient) > 0)
      .sort((a, b) => D.amountOwed(b) - D.amountOwed(a))[0];

    document.getElementById("bestLocation").textContent = best ? best.name : "-";
    document.getElementById("bestLocationDetail").textContent = best
      ? `${best.rate.toFixed(1)}% collection rate · ${D.currency.format(best.collected)} collected`
      : "No qualifying data";

    document.getElementById("largestOutstandingLocation").textContent = largestLocation ? largestLocation.name : "-";
    document.getElementById("largestOutstandingLocationDetail").textContent = largestLocation
      ? `${D.currency.format(largestLocation.outstanding)} outstanding`
      : "No qualifying data";

    document.getElementById("overdueExposure").textContent = D.currency.format(overdueAmount);
    document.getElementById("overdueExposureDetail").textContent = `${overdue.length} overdue ${overdue.length === 1 ? "account" : "accounts"}`;

    document.getElementById("largestBalance").textContent = largestPatient ? D.currency.format(D.amountOwed(largestPatient)) : "$0.00";
    document.getElementById("largestBalanceDetail").textContent = largestPatient
      ? `${largestPatient.name} · ${largestPatient.mrn}`
      : "No open balances";
  }

  function renderFilterContext(selected) {
    const parts = [`Showing ${selected.length} of ${patients.length} accounts`];
    if (elements.fromDate.value || elements.toDate.value) {
      const from = elements.fromDate.value ? D.formatDate(elements.fromDate.value) : "the beginning";
      const to = elements.toDate.value ? D.formatDate(elements.toDate.value) : "today and beyond";
      parts.push(`collection dates from ${from} through ${to}`);
    }
    document.getElementById("filterContext").textContent = `${parts.join(" · ")}.`;
  }


  function captureAnalysisSettings() {
    return {
      fromDate: elements.fromDate.value,
      toDate: elements.toDate.value,
      location: elements.location.value,
      treatment: elements.treatment.value,
      status: elements.status.value,
      groupBy: elements.groupBy.value,
      breakdownSort: elements.breakdownSort.value
    };
  }

  function renderSavedAnalysisViews(selectedId = "") {
    const views = D.loadSavedViews("analytics");
    elements.savedViewSelect.innerHTML = '<option value="">Choose a saved analysis</option>';
    views.forEach((view) => {
      const option = document.createElement("option");
      option.value = view.id;
      option.textContent = view.name;
      elements.savedViewSelect.appendChild(option);
    });
    elements.savedViewSelect.value = views.some((view) => view.id === selectedId) ? selectedId : "";
    document.getElementById("deleteAnalyticsViewButton").disabled = !elements.savedViewSelect.value;
  }

  function applyAnalysisSettings(settings) {
    elements.fromDate.value = settings.fromDate || "";
    elements.toDate.value = settings.toDate || "";
    elements.location.value = [...elements.location.options].some((option) => option.value === settings.location) ? settings.location : "all";
    elements.treatment.value = [...elements.treatment.options].some((option) => option.value === settings.treatment) ? settings.treatment : "all";
    elements.status.value = [...elements.status.options].some((option) => option.value === settings.status) ? settings.status : "all";
    elements.groupBy.value = settings.groupBy || "location";
    elements.breakdownSort.value = [...elements.breakdownSort.options].some((option) => option.value === settings.breakdownSort) ? settings.breakdownSort : "outstanding:desc";
    const [key, direction] = elements.breakdownSort.value.split(":");
    breakdownSort = { key, direction: direction === "asc" ? "asc" : "desc" };
    renderAll();
  }

  function renderAll() {
    const selected = filteredPatients();
    renderKpis(selected);
    renderMonthlyChart(selected);
    renderStatusChart(selected);
    renderLocationChart(selected);
    renderMethodChart(selected);
    renderPlanPerformance(selected);
    renderBreakdown(selected);
    renderInsights(selected);
    renderFilterContext(selected);
    document.getElementById("analysisUpdated").textContent = `Analysis refreshed ${new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date())}.`;
  }

  [elements.fromDate, elements.toDate, elements.location, elements.treatment, elements.status]
    .forEach((control) => control.addEventListener("change", renderAll));

  elements.groupBy.addEventListener("change", renderAll);

  elements.breakdownSort.addEventListener("change", () => {
    const [key, direction] = elements.breakdownSort.value.split(":");
    breakdownSort = { key, direction: direction === "asc" ? "asc" : "desc" };
    renderBreakdown(filteredPatients());
  });

  document.querySelectorAll(".breakdown-sort").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      if (breakdownSort.key === key) {
        breakdownSort.direction = breakdownSort.direction === "asc" ? "desc" : "asc";
      } else {
        breakdownSort.key = key;
        breakdownSort.direction = key === "name" ? "asc" : "desc";
      }
      syncBreakdownSortSelect();
      renderBreakdown(filteredPatients());
    });
  });

  document.getElementById("last90Button").addEventListener("click", () => {
    elements.fromDate.value = daysAgoIso(89);
    elements.toDate.value = D.todayIso();
    renderAll();
  });

  document.getElementById("clearAnalyticsFilters").addEventListener("click", () => {
    elements.fromDate.value = "";
    elements.toDate.value = "";
    elements.location.value = "all";
    elements.treatment.value = "all";
    elements.status.value = "all";
    renderAll();
  });

  document.getElementById("refreshAnalytics").addEventListener("click", () => {
    patients = D.loadPatients();
    populateFilters();
    renderAll();
    showToast("Analysis refreshed from the Payment Board data.");
  });

  document.getElementById("exportAnalysisButton").addEventListener("click", () => {
    // Export the exact analysis breakdown currently displayed after filters,
    // grouping, and sorting have been applied.
    const selected = filteredPatients();
    const rows = currentBreakdown(selected);
    if (rows.length === 0) {
      showToast("No analysis rows are currently visible to export.", "error");
      return;
    }

    const groupLabel = elements.groupBy.options[elements.groupBy.selectedIndex].text;
    const headers = [groupLabel, "Patients", "Patients Paying", "Responsibility", "Collected", "Outstanding", "Collection Rate"];
    const data = rows.map((row) => [
      row.name,
      row.patients,
      row.paying,
      row.responsibility,
      row.collected,
      row.outstanding,
      `${row.rate.toFixed(1)}%`
    ]);
    const csv = [headers, ...data]
      .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ackerman-analysis-current-view-${elements.groupBy.value}-${D.todayIso()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`${rows.length} visible analysis ${rows.length === 1 ? "row" : "rows"} exported.`);
  });


  elements.savedViewSelect.addEventListener("change", () => {
    const view = D.loadSavedViews("analytics").find((item) => item.id === elements.savedViewSelect.value);
    document.getElementById("deleteAnalyticsViewButton").disabled = !view;
    if (view) {
      elements.savedViewName.value = view.name;
      applyAnalysisSettings(view.settings);
    }
  });

  document.getElementById("saveAnalyticsViewButton").addEventListener("click", () => {
    const name = elements.savedViewName.value.trim();
    if (!name) return showToast("Enter a name for the saved analysis.", "error");
    const record = D.saveSavedView("analytics", {
      id: elements.savedViewSelect.value || undefined,
      name,
      settings: captureAnalysisSettings()
    });
    renderSavedAnalysisViews(record.id);
    showToast(`Saved analysis “${name}”.`);
  });

  document.getElementById("deleteAnalyticsViewButton").addEventListener("click", () => {
    const id = elements.savedViewSelect.value;
    if (!id) return;
    const name = elements.savedViewSelect.selectedOptions[0]?.textContent || "this analysis";
    if (!window.confirm(`Delete saved analysis "${name}"?`)) return;
    D.deleteSavedView("analytics", id);
    elements.savedViewName.value = "";
    renderSavedAnalysisViews();
    showToast("Saved analysis deleted.");
  });

  // Version 3.3: changes saved on other workstations arrive here without a refresh.
  document.addEventListener("ackerman-remote-change", (event) => {
    D.applyPatientUpdates(patients, event.detail?.patients || [], event.detail?.removed);
    populateFilters();
    renderAll();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === D.STORAGE_KEY) {
      patients = D.loadPatients();
      populateFilters();
      renderAll();
    }
    if (event.key === D.SAVED_VIEWS_KEY) renderSavedAnalysisViews();
  });

  populateFilters();
  renderSavedAnalysisViews();
  syncBreakdownSortSelect();
  renderAll();
})();
