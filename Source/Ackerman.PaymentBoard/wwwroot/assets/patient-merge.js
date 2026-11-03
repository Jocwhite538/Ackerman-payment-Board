(function () {
  "use strict";

  // Three-way merge of one patient record.
  //
  // base   = the version this workstation last loaded from the server
  // mine   = this workstation's version with the user's change applied
  // theirs = the newer version another workstation saved in the meantime
  //
  // Changes to different parts of the record combine cleanly (for example, one
  // person records a payment while another edits the status note). Only when two
  // people change the same part of the same patient at the same time is there a
  // real conflict; then the version already saved on the server is kept and the
  // part that could not be saved is reported back.

  // Fields that belong together are merged as one unit, so a merge can never
  // produce, for example, a responsibility amount from one person combined with
  // a payment schedule from another.
  const GROUPS = [
    { label: "account terms (responsibility, arrangement, schedule)", fields: ["responsibility", "arrangement", "status", "collectionDate", "noResponsibilityReason", "paymentPlan"] },
    { label: "completion status", fields: ["archived", "completedAt", "completionReason", "completionNote"] },
    { label: "treatments", fields: ["treatments", "treatment"] },
    { label: "name", fields: ["name"] },
    { label: "MRN", fields: ["mrn"] },
    { label: "treatment site", fields: ["location"] },
    { label: "insurance", fields: ["insurance"] },
    { label: "status note", fields: ["statusNote"] },
    { label: "finance note", fields: ["notes"] }
  ];

  // Lists whose entries carry an id; entries added on either side are all kept.
  const ID_LISTS = ["payments", "adjustments", "activity"];

  // Recalculated from the rest of the record when it is normalized.
  const DERIVED = ["collected", "updatedAt", "ledgerInitialized"];

  // Never merged: identity and creation stamp.
  const FIXED = ["id", "createdAt"];

  function same(a, b) {
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }

  function mergeGroup(fields, base, mine, theirs) {
    const mineChanged = fields.some((field) => !same(mine[field], base[field]));
    const theirsChanged = fields.some((field) => !same(theirs[field], base[field]));
    if (!mineChanged) return { source: theirs, conflict: false };
    if (!theirsChanged) return { source: mine, conflict: false };
    if (fields.every((field) => same(mine[field], theirs[field]))) return { source: mine, conflict: false };
    return { source: theirs, conflict: true };
  }

  function byId(list) {
    const map = new Map();
    (Array.isArray(list) ? list : []).forEach((entry) => {
      if (entry && entry.id !== undefined && entry.id !== null) map.set(String(entry.id), entry);
    });
    return map;
  }

  function mergeList(baseList, mineList, theirsList) {
    const base = byId(baseList);
    const mine = byId(mineList);
    const theirs = byId(theirsList);
    const result = [];
    let conflict = false;

    theirs.forEach((theirEntry, id) => {
      const mineEntry = mine.get(id);
      const baseEntry = base.get(id);
      if (mineEntry === undefined) {
        // Missing on this workstation: keep it unless this workstation
        // deliberately removed an entry the other side left untouched.
        if (baseEntry !== undefined && same(theirEntry, baseEntry)) return;
        result.push(theirEntry);
        return;
      }
      if (same(mineEntry, theirEntry) || same(mineEntry, baseEntry)) { result.push(theirEntry); return; }
      if (same(theirEntry, baseEntry)) { result.push(mineEntry); return; }
      conflict = true;
      result.push(theirEntry);
    });

    mine.forEach((mineEntry, id) => {
      if (theirs.has(id)) return;
      const baseEntry = base.get(id);
      // Added on this workstation: keep it. Removed on the other side and
      // untouched here: leave it removed.
      if (baseEntry === undefined || !same(mineEntry, baseEntry)) result.push(mineEntry);
    });

    return { list: result, conflict };
  }

  function mergePatient(baseInput, mineInput, theirsInput) {
    const base = baseInput || {};
    const mine = mineInput || {};
    const theirs = theirsInput || {};
    const merged = {};
    const conflicts = [];
    const handled = new Set([...FIXED, ...DERIVED, ...ID_LISTS]);

    FIXED.forEach((field) => { merged[field] = theirs[field] !== undefined ? theirs[field] : mine[field]; });

    GROUPS.forEach((group) => {
      group.fields.forEach((field) => handled.add(field));
      const outcome = mergeGroup(group.fields, base, mine, theirs);
      if (outcome.conflict) conflicts.push(group.label);
      group.fields.forEach((field) => {
        if (outcome.source[field] !== undefined) merged[field] = outcome.source[field];
      });
    });

    ID_LISTS.forEach((field) => {
      const outcome = mergeList(base[field], mine[field], theirs[field]);
      if (outcome.conflict) conflicts.push(field === "activity" ? "activity timeline" : field);
      merged[field] = outcome.list;
    });

    // Any other field (for example one added in a later version) merges on its own.
    const otherFields = new Set([...Object.keys(mine), ...Object.keys(theirs)].filter((field) => !handled.has(field)));
    otherFields.forEach((field) => {
      const outcome = mergeGroup([field], base, mine, theirs);
      if (outcome.conflict) conflicts.push(field);
      if (outcome.source[field] !== undefined) merged[field] = outcome.source[field];
    });

    // Derived values are recalculated by normalization; carry the newest timestamp.
    merged.collected = theirs.collected;
    merged.ledgerInitialized = theirs.ledgerInitialized !== undefined ? theirs.ledgerInitialized : mine.ledgerInitialized;
    merged.updatedAt = [mine.updatedAt, theirs.updatedAt].filter(Boolean).sort().pop() || "";

    return { patient: merged, conflicts };
  }

  window.AckermanMerge = Object.freeze({ mergePatient });
})();
