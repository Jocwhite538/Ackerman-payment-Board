(function () {
  "use strict";

  const D = window.AckermanData;
  const Server = window.AckermanServer;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_FILES_PER_PATIENT = 20;

  let currentPatient = null;
  let currentRecords = [];

  async function list(patientId) {
    if (!Server?.enabled) throw new Error("Shared document storage is unavailable.");
    return (await Server.fetchJson(`/api/documents/patient/${encodeURIComponent(String(patientId))}`)) || [];
  }

  async function count(patientId) {
    const records = await list(patientId);
    return records.length;
  }

  async function add(patientId, file) {
    const form = new FormData();
    form.append("file", file, file.name);
    const headers = new Headers();
    if (Server.csrfToken) headers.set("X-CSRF-TOKEN", Server.csrfToken);
    const response = await fetch(`/api/documents/patient/${encodeURIComponent(String(patientId))}`, {
      method: "POST",
      body: form,
      headers,
      credentials: "same-origin"
    });
    if (response.status === 401) {
      window.location.assign("/account/login");
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (!response.ok) {
      let message = `Could not attach ${file.name}.`;
      try { message = (await response.json()).message || message; } catch (_) {}
      throw new Error(message);
    }
    return response.json();
  }

  async function remove(id) {
    await Server.fetchJson(`/api/documents/${encodeURIComponent(String(id))}`, { method: "DELETE" });
  }

  function ensureDialog() {
    if (document.getElementById("documentsDialog")) return;
    const dialog = document.createElement("dialog");
    dialog.id = "documentsDialog";
    dialog.className = "documents-dialog";
    dialog.innerHTML = `
      <div class="modal-header">
        <div><h2 id="documentsTitle">Patient Documents</h2><p id="documentsSubtitle">-</p></div>
        <button class="icon-button" id="documentsCloseTop" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="document-warning"><strong>Shared internal storage.</strong> Documents are stored on the Version 3 application server and are available to authorized users. Production use remains subject to IT approval and server security controls.</div>
        <div class="document-upload-panel">
          <div class="field"><label for="documentFiles">Choose documents</label><input id="documentFiles" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp"><span class="field-hint">Up to 10 MB per file and 20 files per patient.</span></div>
          <button class="btn btn-primary" id="uploadDocumentsButton" type="button">Attach Selected Files</button>
        </div>
        <div class="document-list-heading"><h3>Attached Documents</h3><span id="documentCountLabel">0 documents</span></div>
        <div id="documentsList" class="documents-list"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-ghost" id="documentsCloseBottom" type="button">Close</button></div>`;
    document.body.appendChild(dialog);

    const close = () => dialog.close();
    document.getElementById("documentsCloseTop").addEventListener("click", close);
    document.getElementById("documentsCloseBottom").addEventListener("click", close);
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    document.getElementById("uploadDocumentsButton").addEventListener("click", uploadSelected);
    document.getElementById("documentsList").addEventListener("click", handleListAction);
  }

  function message(text, type = "success") {
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
    window.setTimeout(() => toast.remove(), 4200);
  }

  function formatAddedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function fileTypeLabel(record) {
    const extension = record.name.includes(".") ? record.name.split(".").pop().toUpperCase() : "FILE";
    return extension.slice(0, 8);
  }

  async function renderList() {
    const container = document.getElementById("documentsList");
    if (!currentPatient) return;
    container.innerHTML = '<div class="document-loading">Loading attached documents...</div>';
    try {
      currentRecords = await list(currentPatient.id);
      document.getElementById("documentCountLabel").textContent = `${currentRecords.length} ${currentRecords.length === 1 ? "document" : "documents"}`;
      if (!currentRecords.length) {
        container.innerHTML = '<div class="document-empty"><strong>No documents attached</strong>Attach a document above when needed.</div>';
      } else {
        container.innerHTML = currentRecords.map((record) => `
          <article class="document-item">
            <div class="document-type">${D.escapeHtml(fileTypeLabel(record))}</div>
            <div class="document-info"><strong title="${D.escapeHtml(record.name)}">${D.escapeHtml(record.name)}</strong><span>${D.formatFileSize(record.size)} · Attached ${D.escapeHtml(formatAddedAt(record.addedAt))}${record.addedBy ? ` by ${D.escapeHtml(record.addedBy)}` : ""}</span></div>
            <div class="document-actions">
              <button class="btn btn-ghost btn-small" type="button" data-document-action="open" data-document-id="${D.escapeHtml(record.id)}">Open</button>
              <button class="btn btn-secondary btn-small" type="button" data-document-action="download" data-document-id="${D.escapeHtml(record.id)}">Download</button>
              <button class="btn btn-danger btn-small" type="button" data-document-action="delete" data-document-id="${D.escapeHtml(record.id)}">Delete</button>
            </div>
          </article>`).join("");
      }
      document.dispatchEvent(new CustomEvent("ackerman-docs-changed", { detail: { patientId: currentPatient.id, count: currentRecords.length } }));
    } catch (error) {
      container.innerHTML = `<div class="document-empty"><strong>Document storage unavailable</strong>${D.escapeHtml(error.message)}</div>`;
      message(error.message, "error");
    }
  }

  async function uploadSelected() {
    if (!currentPatient) return;
    const input = document.getElementById("documentFiles");
    const files = Array.from(input.files || []);
    if (!files.length) return message("Choose at least one file to attach.", "error");

    let existingCount;
    try { existingCount = await count(currentPatient.id); } catch (error) { return message(error.message, "error"); }
    if (existingCount + files.length > MAX_FILES_PER_PATIENT) return message(`A patient can have no more than ${MAX_FILES_PER_PATIENT} documents.`, "error");
    const oversized = files.find((file) => file.size > MAX_FILE_SIZE);
    if (oversized) return message(`${oversized.name} exceeds the 10 MB limit.`, "error");

    const button = document.getElementById("uploadDocumentsButton");
    button.disabled = true;
    button.textContent = "Attaching...";
    try {
      for (const file of files) {
        const record = await add(currentPatient.id, file);
        document.dispatchEvent(new CustomEvent("ackerman-document-event", { detail: { patientId: currentPatient.id, action: "attached", name: record.name, documentId: record.id } }));
      }
      input.value = "";
      await renderList();
      message(`${files.length} ${files.length === 1 ? "document" : "documents"} attached to ${currentPatient.name}.`);
    } catch (error) {
      message(error.message || "Could not attach the selected documents.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Attach Selected Files";
    }
  }

  function getCurrentRecord(id) { return currentRecords.find((record) => record.id === id); }

  async function handleListAction(event) {
    const button = event.target.closest("button[data-document-action]");
    if (!button) return;
    const record = getCurrentRecord(button.dataset.documentId);
    if (!record) return;
    const id = encodeURIComponent(record.id);
    if (button.dataset.documentAction === "open") {
      window.open(`/api/documents/${id}`, "_blank", "noopener,noreferrer");
      return;
    }
    if (button.dataset.documentAction === "download") {
      const link = document.createElement("a");
      link.href = `/api/documents/${id}?download=true`;
      link.download = record.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }
    if (button.dataset.documentAction === "delete") {
      if (!window.confirm(`Delete the attachment "${record.name}"?`)) return;
      try {
        await remove(record.id);
        document.dispatchEvent(new CustomEvent("ackerman-document-event", { detail: { patientId: currentPatient.id, action: "deleted", name: record.name, documentId: record.id } }));
        await renderList();
        message(`${record.name} deleted from ${currentPatient.name}.`);
      } catch (error) { message(error.message || "Could not delete the attachment.", "error"); }
    }
  }

  async function open(patient) {
    ensureDialog();
    currentPatient = patient;
    document.getElementById("documentsTitle").textContent = `${patient.name} Documents`;
    document.getElementById("documentsSubtitle").textContent = `${patient.mrn} · Shared internal document storage`;
    document.getElementById("documentFiles").value = "";
    document.getElementById("documentsDialog").showModal();
    await renderList();
  }

  async function clearAll() {
    throw new Error("Bulk document deletion is disabled in Version 3. Delete documents individually so the audit history remains clear.");
  }

  ensureDialog();
  window.AckermanDocuments = { open, list, count, clearAll };
})();
