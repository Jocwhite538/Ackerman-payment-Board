# Ackerman Patient Payment Board

An internal web app that helps Finance and the Front Desk track patient financial responsibility, payment plans, and collections. It runs on IIS under ASP.NET Core 8, with an embedded LiteDB database.

**Current version: 3.3.** Many people can work at the same time, and the payment ledger is protected on the server. See [docs/VERSION_3_3_CHANGELOG.md](docs/VERSION_3_3_CHANGELOG.md).

> **Keep this repository private.** It contains no patient data (databases and logs are excluded by `.gitignore`), but it is an internal application.

## Try it with demo patients

You need the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).

```
cd Source/Ackerman.PaymentBoard
dotnet run
```

Open http://localhost:5087, create the first Super User on the setup page, and sign in. The board opens with **24 fictional demo patients** (MRNs beginning `DEMO-`). They cover every status: on track, due today, overdue, UF check due, paid in full, no responsibility, and completed. Their dates are moved forward when they load, so the demo always looks current.

The development database is `Source/Ackerman.PaymentBoard/App_Data/dev-ackerman-payment-board.db`. Delete it to start over.

Demo patients load only when `Demo:SeedPatients` is `true` **and** the board is completely empty. That setting is on in `appsettings.Development.json` and off in every other settings file. To show the demo on a **test** IIS site, set it to `true` in that site's `appsettings.Production.json` before the first start. Never turn it on for the production board.

## Build for IIS

- **On your machine:** with the .NET 8 SDK installed, run `Build\Build-IIS-Drop.cmd`.
- **On GitHub:** every push to `main` runs the **Build and test** workflow. It produces the IIS-ready folder as a downloadable artifact named `Ackerman-IIS-Site-Version-3.3` (Actions tab → latest run → Artifacts).

Then follow [docs/UPGRADE_TO_3_3.md](docs/UPGRADE_TO_3_3.md), or [docs/IT_DEPLOYMENT_README.md](docs/IT_DEPLOYMENT_README.md) for a new install.

## Automated checks (GitHub Actions)

| Job | What it checks |
|---|---|
| Real server tests (Linux) | Builds and starts the actual app with demo patients, with the server clock set to Eastern time. Then it signs in and checks the API end to end: saves, conflicts (409), refused ledger edits and deletions, server stamps, duplicate MRN and bad-id refusals, the changes feed, version history, the audit log, and the failed-login lockout. |
| Multi-user browser tests | Merge unit tests, plus the real pages driven by 3 users (23 checks) and by 12 users on the same patients. These run against the stand-in server in `tests/browser`. |
| IIS deployment package (Windows) | Runs `Build/Build-IIS-Drop.ps1` and uploads the IIS folder. Runs only if both test jobs pass. |

## Repository layout

| Path | What it is |
|---|---|
| `Source/Ackerman.PaymentBoard/` | The application (`DemoData/` holds the fictional demo patients) |
| `Build/` | IIS build script |
| `docs/` | Changelogs, IT deployment, security and upgrade notes |
| `tests/api/` | End-to-end checks against the real server |
| `tests/browser/` | Multi-user browser tests and the stand-in server |
| `tools/` | `generate-demo-patients.js` (rebuilds the demo file) |
| `.github/workflows/` | The build-and-test workflow |
