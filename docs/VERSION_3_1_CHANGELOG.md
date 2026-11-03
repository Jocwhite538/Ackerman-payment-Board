# Version 3.1 — IIS Handoff Packaging

Version 3.1 does not redesign the Payment Board workflow. It changes the deployment/handoff model to match IT's preferred IIS process.

## Changes

- Added a Windows x64 self-contained publish profile.
- Added a one-command build script that produces a complete IIS physical-path directory.
- Added automatic ZIP creation for the IIS deployment directory.
- Added an optional CI workflow that can produce the same IIS artifact away from the production server.
- Added a production configuration using a self-contained `App_Data` database path.
- Added an explicit first-run Super User setup procedure.
- Clarified that the root URL is application-routed: setup/login/Payment Board; no physical `index.html` default document is needed.
- Rewrote the IT deployment instructions around **copy directory -> Add IIS Application -> HTTPS -> browse root URL**.
- Documented IIS application-pool settings and folder permissions.
- Kept Finance and Front Desk at the same Standard User permission level.
