# Initial Production Setup

1. IT deploys the prepared IIS site over HTTPS.
2. Keep access limited to the approved internal network during setup.
3. With an empty user database and `AllowFirstRunSetup=true`, browse the root URL.
4. Create the first Super User account.
5. Confirm login and User Management work.
6. Change `Security:AllowFirstRunSetup` to `false` in `appsettings.Production.json`.
7. Restart/recycle the application if required by IIS.
8. The root URL will thereafter send signed-out users to Login.

There is **no hard-coded production username or password**.
