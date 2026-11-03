# Upgrade an Existing IIS Site to Version 3.3

Version 3.3 changes how patient data is stored. Take the backup in step 3 before starting.

1. On a developer/build machine with the .NET 8 SDK, run `Build\Build-IIS-Drop.cmd`. It produces `IIS_SITE_OUTPUT` and `Ackerman_IIS_SITE_Version_3_3.zip`. The repository holds source only; build output is never committed.
2. Stop the **Ackerman Payment Board** site and the `AckermanPaymentBoard` application pool.
3. **Back up `App_Data`** (the whole folder, including `ackerman-payment-board.db`).
4. Replace the application files with the new `IIS_SITE_OUTPUT`, keeping the existing `App_Data` folder.
5. Check that `appsettings.Production.json` still has `Security:AllowFirstRunSetup` set to `false` (the build copies the source version, which ships as `true`), and `Demo:SeedPatients` set to `false`.
6. Confirm the application pool: No Managed Code, Maximum Worker Processes = 1, Disable Overlapped Recycle = True, and Modify permission on `App_Data`.
7. Start the application pool and site, then sign in as a Super User.
8. Open **User Management**. The audit history should show **Board migrated to per-patient records** with the number of patients imported and demo patients removed. Check that the count matches what you expect. If the summary lists skipped ids or patients that share an MRN, review those patients.
   - If the migration cannot read the 3.2 board, the site will not start (IIS error 500.30) and nothing is changed. Check the Windows Application event log for the message, and restore from the step 3 backup if needed.
9. Ask everyone to refresh any open Payment Board tabs (Ctrl+F5 if a page looks stale).
10. Note for staff: failed-login lockout now works. After 5 wrong passwords an account is locked for 15 minutes; a Super User can unlock it sooner by resetting the password.

## Quick check with two workstations

- On A, record a payment for a test patient. On B, without refreshing, edit that patient's status note. Both should be saved, with no warning.
- Within about 8 seconds, each workstation should show the other's change without refreshing.
- On A and B, type different status notes for the same patient. The second one shows a message that the first person's note was kept.

## Rolling back

Stop the site, restore the `App_Data` backup from step 3, and redeploy the 3.2 files. Data entered while 3.3 was running exists only in the 3.3 database, so export or re-enter it before rolling back.
