# IIS LiteDB Fix — Version 3.1.2

Local IIS validation of Version 3.1 identified an IIS-specific LiteDB issue:

`UnauthorizedAccessException: Access to the path Global\<hash>.Mutex is denied.`

Version 3.1.2 changes the embedded LiteDB connection from `Shared` to `Direct` by default. The application already keeps a single `LiteDatabase` instance for the process lifetime, so Direct mode is appropriate for the intended single-worker IIS deployment.

Recommended IIS application-pool settings:

- No Managed Code
- Integrated pipeline
- Maximum Worker Processes = 1
- Disable Overlapped Recycle = True

This is separate from NTFS permissions: the application-pool identity still needs Modify permission on `App_Data`.
