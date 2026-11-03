# Ackerman Patient Payment Board — Version 3.2

## Launch-preparation changes

### Demo data removed
- Fresh installations start with an empty patient board.
- The large fictional/demo patient seed set has been removed from the shipped JavaScript.
- Existing shared-board records with an ID beginning `demo-` or an MRN beginning `DEMO-` are automatically removed when the board is next loaded.
- User accounts, authentication records, and non-demo patient records are preserved.
- Demo/prototype wording was removed from the Payment Board, Analytics, Completed Patients, and printable patient summary.

### Status cleanup
- Removed **Payment Plans** from the main Status filter because the current responsibility workflow uses payment plans by default.
- Removed the generic **All Payment Plans** option from the Analytics Current Status filter. More specific payment-plan analytics such as overdue / due today / on-track remain available.

### Treatment-site cleanup
- Removed **St. Augustine** from the Treatment Site picker.
- Older St. Augustine treatment-site values normalize to Jacksonville when loaded.
- This does not remove `ACC St. Augustine` from the separate payment **office site** list.

### Completed-patient Excel export
Each recorded payment now exports as a three-column group:
- `Payment N Date`
- `Payment N Amount`
- `Payment N Notes`

Payment notes preserve the note entered with the ledger transaction.

### Password length
- Minimum password length changed from 12 characters to **5 characters** for:
  - first Super User setup
  - new user temporary passwords
  - Super User password resets
  - user password changes

> Security note: five characters is intentionally permissive per the requested workflow. IT should approve the final password policy before production use.

### Development credentials
- The shipped Development configuration no longer seeds the `jwhite / pass` test account.
- Production continues to use first-run Super User creation.
