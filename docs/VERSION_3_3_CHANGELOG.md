# Ackerman Patient Payment Board — Version 3.3

Version 3.3 changes how the board is saved so many people can work at the same time, and makes the payment ledger tamper-resistant on the server.

## Simultaneous work (save conflicts fixed)

**Before (3.2):** the whole board was one record with one version number. Any save by anyone (a status note, a document upload) made every other open workstation's next save fail with "refresh first", and the change being entered was lost.

**Now:**
- Each patient is saved on its own, with its own version number. People working on different patients never affect each other.
- Two people changing the **same** patient at the same time are merged automatically when they change different things. For example, one records a payment while another edits the status note: both are kept.
- Two payments recorded on the same patient at the same moment are both kept.
- Only when two people change the **same part** of the same patient at once (for example, both edit the status note) does the second person see a message. The first save is kept, and the second person is told which part was not saved.
- Changes made on other workstations appear on screen within about 8 seconds, without refreshing the page. They are held back while someone has a dialog open or is typing in the table, and applied as soon as they finish.
- Each save sends only the patient that changed (about 2 KB), not the whole board. The board no longer gets slower to save as it grows.

## Payment ledger protection (server-side)

- **Recorded payments and adjustments can't be edited or deleted.** If a browser sends a changed or missing entry, the server keeps the recorded entry as it was and tells the user to record a reversal or correction instead. That is how the board already makes corrections. The refused change is written to the audit history.
- **The server stamps who recorded each entry.** New payments and adjustments get `recordedBy` and `recordedAtUtc` from the signed-in account and the server clock. The payment's "Recorded by" username is also set by the server. Neither can be supplied by the browser.
- **Every saved version of every patient is kept** (`patient_history` collection). Any earlier state of a patient can be recovered. Super Users can list a patient's versions at `/api/patients/{id}/history` and open one at `/api/patients/{id}/history/{revision}`. Both actions are audited.
- **Patients can't be removed through the API.** No board feature deletes patients; completed patients are archived.
- **Duplicate MRNs are refused by the server**, including when two people add the same patient at the same time.
- **The audit history now records amounts**, for example `Payment recorded $250.00 ACC (Card, 2026-11-03)` and `total responsibility $1,000.00 -> $1,200.00`. Free-text notes are reported as changed without copying their text into the audit log.

## Upgrade behavior

- On first start, Version 3.3 copies each patient from the 3.2 board record into its own record. It runs once and is recorded in the `migrations` collection and the audit history.
- Demo patients (ID beginning `demo-` or MRN beginning `DEMO-`) are removed during that one-time copy. The browser no longer does this on every page load.
- The original 3.2 board record is left untouched in the database as a backup.
- A browser still running cached 3.2 JavaScript can view the board but cannot save. It is told to refresh. Page HTML is now served with `Cache-Control: no-store`, and all script links are versioned `?v=3.3.0`, so a normal refresh picks up 3.3.

## Other fixes found while preparing 3.3

- **Failed-login lockout now works.** LiteDB was returning stored dates converted to the server's local time, and the lockout check compared that value with UTC. On a server set to Eastern time, a locked account looked unlocked immediately, and the failure counter reset each time. In 3.2, password guessing was therefore effectively unlimited. Dates are now read back as UTC (`DatabaseFactory`: `UtcDate = true`). After 5 failed attempts an account now really is locked for 15 minutes, and a Super User can clear it with a password reset. To see whether this was happening on your server, look in the 3.2 audit log for runs of 5 or more "Login failed" entries for one user with no "Login blocked" entry.
- **Expired sessions are detected.** API calls now get a 401 instead of the login page, so the board sends the user to sign in rather than showing an empty board or a confusing save error.
- **Patient ids are checked exactly.** LiteDB trims spaces from ids and ignores letter case when looking them up. 3.3 refuses ids that would be changed by that, and never lets one patient's save land on another patient's record.
- **Two patients that already share an MRN** (possible in 3.2) can still be saved. The duplicate check runs only when an MRN is added or changed. The migration summary lists the patient ids involved so they can be cleaned up.
- If saving the audit description fails after a patient was saved, the user is still told the save succeeded and the error is logged. This avoids someone re-entering a payment that was already recorded.

## Limits

- If many people save the **same** patient within the same instant, a save is retried automatically up to 10 times. In testing, 16 people all saving one patient at once succeeded every time at normal network speed. In an extreme case the user sees "please try again" and nothing is saved twice.
- A 3.2 patient with a malformed id (leading or trailing spaces, or control characters) is not imported. It stays in the 3.2 backup document, and its id is listed in the migration summary. 3.2 generated ids never have these characters.
- Every saved version of a patient is kept, so the database grows with use (roughly one copy of the patient, a few KB, per save). Plan backups accordingly.
- After restoring the database from a backup, ask everyone to refresh their open board pages.

## Demo patients (development and test sites)

- `DemoData/demo-patients.json` holds 24 fictional patients (IDs `demo-001`… and MRNs `DEMO-1001`…). Together they cover every board status, UF installments, reversals, refunds, corrections, write-offs, and completed accounts.
- They load only when `Demo:SeedPatients` is `true` **and** the board has no patients at all. They are never added to a board that holds data. Loading is recorded in the audit history.
- Dates in the file are moved forward when they load, so the demo always looks current (some payments due today, some overdue, and so on).
- `Demo:SeedPatients` is `true` in `appsettings.Development.json` and `false` everywhere else. Development also turns on first-run setup, so `dotnet run` gives a working demo.
- To regenerate the file: `node tools/generate-demo-patients.js`.

## Not changed in this version

The document upload content-type issue from the 3.2 review, the 5-character password minimum, and the .NET 8 end-of-support date (November 10, 2026) are still open.
