# Ackerman Patient Payment Board — Version 3.1.2

## IIS publish fix: protected application pages

Version 3.1.2 fixes an IIS packaging issue discovered during local acceptance testing.

### Symptom
- IIS setup/login worked.
- First Super User creation succeeded.
- After login, the browser redirected to `/app` and returned HTTP 404.

### Root cause
`AppController` serves the protected Payment Board pages from the application's `AppPages` directory. Those HTML files were present in source but were not explicitly marked for publication, so `dotnet publish` could omit `AppPages` from the IIS deployment folder.

### Fix
- `AppPages/index.html`, `AppPages/analytics.html`, and `AppPages/completed.html` are now explicitly copied to build and publish output.
- The IIS build script now fails the build if any required `AppPages` file is missing.
- The LiteDB IIS Direct-mode fix from Version 3.1.1 is retained.

### Expected result
After rebuilding and replacing the IIS deployment folder, authenticated users can open:
- `/app` — Payment Board
- `/app/analytics` — Statistical Analysis
- `/app/completed` — Completed Patients
