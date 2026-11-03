# Version 3 Security Notes

Version 3 introduces application-level security controls, but final production security depends on Ackerman IT deployment and policy.

## Implemented in the application

- server-side username/password authentication
- hashed passwords using ASP.NET Core PasswordHasher
- Super User and Standard User authorization
- account enable/disable controls
- failed-login lockout
- password reset with required change on next login
- HTTP-only, Secure, SameSite authentication cookies
- session expiration/sliding timeout
- anti-forgery protection for state changes and document operations
- authenticated API endpoints
- server-side document storage
- server-side audit history
- concurrency protection against silent overwrite of newer board state
- authenticated username automatically recorded in payment workflow

## Not a substitute for IT controls

The application does not replace requirements for:
- Windows/IIS hardening
- network access controls
- TLS certificate management
- server/database file permissions
- backups
- malware/EDR protection
- operating-system patching
- enterprise log retention/monitoring
- organizational HIPAA risk assessment and approval

Do not enter real patient information until IT confirms the deployed environment is approved for that use.
