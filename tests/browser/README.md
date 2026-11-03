# Version 3.3 browser tests

These are the tests used to check the Version 3.3 multi-user saving. They are for developers, not for the IIS server.

- `unit.js` covers the patient merge rules and checks that normalizing a patient twice gives the same result.
- `mock-server.js` is a small Node stand-in for the ASP.NET Core server. It follows the same API and ledger rules as `LiteDbPatientStore.cs` and `PatientLedgerGuard.cs`, and serves the real `AppPages` and `wwwroot` files.
- `concurrency.js` drives the real pages as three signed-in users (23 checks): merges, conflicts, live updates, deferral while a dialog is open, simultaneous payments, ledger tampering, duplicate MRN, and an old 3.2 client.
- `stress.js` has N users repeatedly recording payments and notes on the same three patients, then checks that no payment was lost and every screen matches the server.

Run (Node 18+ and Playwright):

```
cd tests/browser
node seed.js ../../Source/Ackerman.PaymentBoard/wwwroot/assets
node unit.js ../../Source/Ackerman.PaymentBoard/wwwroot/assets
node mock-server.js ../../Source/Ackerman.PaymentBoard 5099 legacy.json      (leave running)
node concurrency.js http://localhost:5099
MOCK_LATENCY_MS=15 node mock-server.js ../../Source/Ackerman.PaymentBoard 5099 legacy.json   (fresh server)
node stress.js http://localhost:5099 12 6
```

Results when Version 3.3 was prepared:
- 10/10 unit tests and 23/23 concurrency checks passed.
- Stress test with 12 users and 72 actions on three patients: 0 lost payments, and all screens in sync.
- Worst case, 16 users saving the same patient at once (`STRESS_IDS=patient-p1 node stress.js ... 16 4`): all 64 saves succeeded at 15–40 ms server response time. With every request artificially delayed by 120 ms, an occasional save gave up after 10 retries. That save showed "please try again", and nothing was lost.

The real C# server should also be checked on the test IIS site using the two-workstation steps in `UPGRADE_TO_3_3.md`.
