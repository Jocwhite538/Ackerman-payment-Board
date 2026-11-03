# Version 3 Acceptance Test Checklist

Use fictional test data until IT approves production use.

## Authentication

- [ ] First-run setup creates exactly one initial Super User.
- [ ] Login works with valid credentials.
- [ ] Invalid password is rejected.
- [ ] Failed-login lockout activates after configured attempts.
- [ ] Disabled user cannot sign in or continue using an existing session.
- [ ] Logout ends the session.
- [ ] Session timeout behaves according to IT policy.
- [ ] Reset password forces change on next sign-in.
- [ ] Role changes take effect immediately by requiring a new sign-in.

## Authorization

- [ ] Standard User can use Payment Board, Payments, Docs, Analytics, Completed Patients.
- [ ] Standard User cannot access `/admin`.
- [ ] Super User can access User Management.
- [ ] Super User can add users, reset passwords, change roles, disable/enable accounts.
- [ ] Super User cannot disable or demote their own active Super User account.

## Shared data

- [ ] Add a fictional patient on Workstation A.
- [ ] Refresh Workstation B and confirm the patient appears.
- [ ] Update a patient on Workstation A and confirm Workstation B gets the “New shared data” refresh banner.
- [ ] Confirm stale Workstation B cannot silently overwrite a newer revision.
- [ ] Record ACC payment and verify Total/ACC collected and outstanding amounts.
- [ ] Record UF payment and verify UF totals / UF check workflow.
- [ ] Complete and restore a fictional account.

## Documents

- [ ] Attach permitted fictional file.
- [ ] File appears for another authorized workstation.
- [ ] Open/download works.
- [ ] Delete works.
- [ ] Over-10-MB upload is rejected.
- [ ] Disallowed extension is rejected.

## Audit

- [ ] Successful/failed login events appear.
- [ ] User creation/reset/role/disable events appear.
- [ ] Patient update/save audit entries identify signed-in user.
- [ ] Document attach/delete events appear.

## UI

- [ ] Light mode works on login, board, analytics, completed, admin, and dialogs.
- [ ] Dark mode works on all of the above.
- [ ] Collapse/Expand patient rows works.
- [ ] Payments, Docs, View Details, Complete remain usable.
- [ ] Excel export opens without repair warning.
