(function () {
  "use strict";

  // Version 3.3: every patient is saved on its own, with its own revision.
  // - Only the patients that actually changed are sent to the server.
  // - If someone else saved the same patient first, the two versions are merged
  //   (see patient-merge.js) and saved again; the user only hears about it when
  //   both people changed the same part of the same patient.
  // - Changes made on other workstations are pulled in every few seconds and
  //   shown without a page refresh, but never while someone is in the middle of
  //   an edit (a dialog is open or they are typing in the table).

  const POLL_MS = 8000;
  const MAX_SAVE_ATTEMPTS = 10;

  let csrfToken = "";
  let session = { username: "", role: "StandardUser", isSuperUser: false };
  let seq = 0;
  let loaded = false;
  let polling = false;
  let normalize = (patient) => patient;
  const known = new Map();   // patient id -> { revision, baseline: JSON of the normalized server version }
  const pending = new Map(); // patient id -> newer server record waiting until the user is not mid-edit

  function request(method, url, body) {
    // Synchronous on purpose: the board's save handlers expect a save to be
    // finished (or to have failed) before they close dialogs and show a toast.
    // A request now carries one patient, so it completes almost instantly.
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    xhr.setRequestHeader("Accept", "application/json");
    if (body !== undefined && body !== null) xhr.setRequestHeader("Content-Type", "application/json");
    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) xhr.setRequestHeader("X-CSRF-TOKEN", csrfToken);
    try {
      xhr.send(body === undefined || body === null ? null : JSON.stringify(body));
    } catch (error) {
      throw new Error("Could not reach the Ackerman Payment Board server. Your last change was not saved.");
    }
    if (xhr.status === 401 || /\/account\/(login|change-password)/i.test(xhr.responseURL || "")) {
      window.location.assign("/account/login");
      throw new Error("Your session has expired. Please sign in again.");
    }
    let payload = null;
    let unreadable = false;
    try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (_) { unreadable = true; }
    if (unreadable && xhr.status >= 200 && xhr.status < 300) {
      throw new Error("The server sent an unexpected response. Refresh the page and sign in again if asked.");
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      const error = new Error(payload?.message || `Server request failed (${xhr.status}).`);
      error.status = xhr.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function initialize() {
    try {
      const anti = request("GET", "/api/antiforgery");
      csrfToken = anti?.token || "";
      session = request("GET", "/api/session") || session;
    } catch (error) {
      console.error(error);
    }
  }

  function useNormalizer(fn) {
    if (typeof fn === "function") normalize = fn;
  }

  function remember(record) {
    const patient = normalize(record.data);
    known.set(String(record.id), { revision: Number(record.revision || 0), baseline: JSON.stringify(patient) });
    const queued = pending.get(String(record.id));
    if (queued && Number(queued.revision) <= Number(record.revision || 0)) pending.delete(String(record.id));
    return patient;
  }

  function knownCopy(id) {
    const entry = known.get(id);
    return entry ? JSON.parse(entry.baseline) : null;
  }

  function loadPatients() {
    const result = request("GET", "/api/patients");
    if (!result || !Array.isArray(result.patients)) throw new Error("The patient list could not be loaded. Refresh the page.");
    known.clear();
    pending.clear();
    seq = Number(result.seq || 0);
    const patients = result.patients.map(remember);
    loaded = true;
    return { found: true, normalized: true, patients, seq };
  }

  function listText(items) {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  }

  function savePatient(patient, outcome) {
    const id = String(patient.id);
    let mine = patient;
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const entry = known.get(id);
      try {
        const result = request("PUT", `/api/patients/${encodeURIComponent(id)}`, { revision: entry ? entry.revision : 0, patient: mine });
        const saved = remember({ id, revision: result.revision, data: result.patient });
        if (JSON.stringify(saved) !== JSON.stringify(patient)) outcome.replacements.set(id, saved);
        if (mine !== patient || (result.warnings || []).length) outcome.redraw.add(id);
        (result.warnings || []).forEach((warning) => outcome.notices.push(warning));
        return;
      } catch (error) {
        if (error.status !== 409 || !error.payload?.patient) throw error;
        // Someone else saved this patient first. Merge their version with ours.
        const base = entry ? JSON.parse(entry.baseline) : null;
        const theirs = remember({ id, revision: error.payload.revision, data: error.payload.patient });
        if (!window.AckermanMerge) throw new Error("This page is out of date. Refresh it (Ctrl+F5) and try again; your last change was not saved.");
        const merge = window.AckermanMerge.mergePatient(base, mine, theirs);
        if (merge.conflicts.length) {
          const who = error.payload.updatedBy || "another user";
          outcome.notices.push(`${theirs.name || "This patient"} was also being changed by ${who}. Their ${listText(merge.conflicts)} ${merge.conflicts.length === 1 ? "was" : "were"} kept, so your change to ${merge.conflicts.length === 1 ? "it" : "those"} was not saved. Please check the patient and re-enter it if it is still needed.`);
        }
        mine = normalize(merge.patient);
        if (JSON.stringify(mine) === known.get(id).baseline) {
          // Nothing of ours is left to save (it was already there, or it conflicted).
          outcome.replacements.set(id, theirs);
          outcome.redraw.add(id);
          return;
        }
      }
    }
    throw new Error(`${patient.name || "This patient"} is being changed on several workstations right now. Your change was not saved; please try again.`);
  }

  function savePatients(patients) {
    const outcome = { replacements: new Map(), removals: new Set(), redraw: new Set(), notices: [] };
    const present = new Set();
    let failure = null;

    for (const patient of patients) {
      const id = String(patient.id);
      present.add(id);
      const entry = known.get(id);
      if (entry && entry.baseline === JSON.stringify(patient)) continue; // unchanged
      try {
        savePatient(patient, outcome);
      } catch (error) {
        failure = failure || error;
        // Put this workstation back in step with the server for that patient,
        // so the rejected change is not shown as saved or re-sent later.
        const serverCopy = knownCopy(id);
        if (serverCopy) { outcome.replacements.set(id, serverCopy); outcome.redraw.add(id); } else outcome.removals.add(id);
      }
    }

    // When the saved version differs from what the user has on screen (merged with
    // someone else's change, or a change was refused), redraw those patients once
    // the page has finished handling the save.
    if (outcome.redraw.size || outcome.removals.size) {
      const updated = [...outcome.redraw].map((id) => outcome.replacements.get(id)).filter(Boolean);
      const removed = [...outcome.removals];
      window.setTimeout(() => document.dispatchEvent(new CustomEvent("ackerman-remote-change", { detail: { patients: updated, removed } })), 0);
    }

    known.forEach((_, id) => {
      if (!present.has(id)) console.warn(`Patient ${id} is missing from this page's list; patients are not deleted from the shared board.`);
    });

    if (outcome.notices.length) notify(outcome.notices.join(" "), "error", 12000);
    if (failure) {
      window.alert(failure.message || "Your change could not be saved.");
      failure.outcome = outcome;
      throw failure;
    }
    return outcome;
  }

  async function fetchJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes((options.method || "GET").toUpperCase())) headers.set("X-CSRF-TOKEN", csrfToken);
    const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
    if (response.status === 401) {
      window.location.assign("/account/login");
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (!response.ok) {
      let message = `Server request failed (${response.status}).`;
      try { message = (await response.json()).message || message; } catch (_) {}
      throw new Error(message);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function userIsEditing() {
    if (document.querySelector("dialog[open]")) return true;
    const active = document.activeElement;
    return Boolean(active && active.matches && active.matches("input, textarea, select") && active.closest("table, dialog"));
  }

  function applyPending() {
    if (!pending.size || userIsEditing()) return;
    const changed = [];
    pending.forEach((record, id) => {
      const entry = known.get(id);
      if (entry && Number(record.revision) <= entry.revision) return;
      changed.push(remember(record));
    });
    pending.clear();
    if (changed.length) document.dispatchEvent(new CustomEvent("ackerman-remote-change", { detail: { patients: changed } }));
  }

  async function poll() {
    if (!loaded || polling || document.hidden) return;
    polling = true;
    try {
      const result = await fetchJson(`/api/patients/changes?since=${encodeURIComponent(seq)}`);
      seq = Math.max(seq, Number(result?.seq || 0));
      (result?.patients || []).forEach((record) => {
        const id = String(record.id);
        const entry = known.get(id);
        if (entry && Number(record.revision) <= entry.revision) return; // our own save, or already applied
        const queued = pending.get(id);
        if (queued && Number(queued.revision) >= Number(record.revision)) return;
        pending.set(id, record);
      });
      applyPending();
    } catch (error) {
      console.warn("Could not check for changes from other workstations.", error);
    } finally {
      polling = false;
    }
  }

  function notify(text, type = "success", duration = 4600) {
    let region = document.getElementById("toastRegion");
    if (!region) {
      region = document.createElement("div");
      region.id = "toastRegion";
      region.className = "toast-region";
      region.setAttribute("aria-live", "polite");
      document.body.appendChild(region);
    }
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " error" : ""}`;
    toast.textContent = text;
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), duration);
  }

  async function logout() {
    const headers = new Headers();
    if (csrfToken) headers.set("X-CSRF-TOKEN", csrfToken);
    await fetch("/account/logout", { method: "POST", headers, credentials: "same-origin" });
    window.location.assign("/account/login");
  }

  function decorateHeader() {
    document.querySelectorAll(".header-tools").forEach((tools) => {
      if (tools.querySelector(".session-user")) return;
      const wrap = document.createElement("div");
      wrap.className = "session-user";
      const admin = session.isSuperUser ? '<a class="session-admin-link" href="/admin">User Management</a>' : "";
      wrap.innerHTML = `${admin}<a class="session-admin-link" href="/account/change-password">Change Password</a><span class="session-username" title="Signed in user">${escapeHtml(session.username || "Signed in")}</span><button class="session-logout" type="button">Sign out</button>`;
      tools.insertBefore(wrap, tools.firstChild);
      wrap.querySelector(".session-logout")?.addEventListener("click", logout);
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  initialize();
  window.AckermanSession = Object.freeze({ ...session });
  window.AckermanServer = {
    enabled: true,
    get session() { return session; },
    get csrfToken() { return csrfToken; },
    useNormalizer,
    loadPatients,
    savePatients,
    fetchJson,
    checkNow: poll,
    logout
  };
  document.addEventListener("DOMContentLoaded", () => {
    decorateHeader();
    window.setInterval(poll, POLL_MS);
  });
  // Apply waiting changes as soon as the user finishes an edit.
  document.addEventListener("close", () => window.setTimeout(applyPending, 50), true);
  document.addEventListener("focusout", () => window.setTimeout(applyPending, 300), true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
})();
