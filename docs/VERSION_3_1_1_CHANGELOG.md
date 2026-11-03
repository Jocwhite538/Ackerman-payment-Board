# Ackerman Patient Payment Board — Version 3.1.1

## IIS validation fix

- Changed the default LiteDB connection mode from `Shared` to `Direct` for the IIS deployment.
- Added `Database:Connection` configuration so the connection mode is explicit.
- Fixes the IIS error `UnauthorizedAccessException: Access to the path Global\<hash>.Mutex is denied`.
- Documented single-worker-process IIS settings for the embedded database.
- Retains the existing `App_Data` permission requirement for the application-pool identity.
- No Payment Board workflow/UI logic changed.
