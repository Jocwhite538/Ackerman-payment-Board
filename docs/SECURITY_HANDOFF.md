# Security Handoff Notes

- Internal HTTPS only.
- Server-side cookie authentication.
- HttpOnly authentication cookie; Secure cookie in Production.
- Passwords stored as hashes, not plaintext.
- Failed-login lockout is enabled.
- Standard Users (Finance and Front Desk) currently share the same rights.
- Super Users can create/disable users, change roles, and reset passwords.
- Password reset creates a new temporary password; it does not reveal the old password.
- Server-side audit records capture login and material account/application changes.
- Browser clients do not receive database credentials and do not connect directly to the database.
- `App_Data` must not be exposed as static content and should be protected by IIS filesystem permissions.
- Backups and retention for the database/document store should follow Ackerman IT policy before production use.
