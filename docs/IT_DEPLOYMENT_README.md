# IT Deployment — Copy Folder, Add IIS Application

## Deployment model

`Employee browser -> HTTPS -> IIS -> Ackerman Patient Payment Board -> self-contained application database`

The browser never connects directly to the database.

## Artifact IT should deploy

Deploy the contents of:

`Ackerman_IIS_SITE_Version_3_2.zip`

This is generated before handoff. IT should not need to restore NuGet packages or compile source on the IIS server.

## IIS steps

1. Extract the deployment ZIP to the desired server directory, for example:
   `D:\WebApps\AckermanPatientPaymentBoard`
2. In IIS Manager, create a new **Application** or **Site** and set that directory as the Physical Path.
3. Application Pool:
   - .NET CLR version: **No Managed Code**
   - Managed pipeline mode: Integrated
4. Confirm the **ASP.NET Core Module v2** is installed on IIS.
5. Configure the internal HTTPS binding and approved certificate.
6. File permissions:
   - Read/Execute: application directory
   - Modify: `App_Data` for the application-pool identity
   - Modify: `logs` only if stdout logging is enabled for troubleshooting
7. Browse the root URL, for example `https://patientpayments/`.

## Home page / default document

No `index.html` default document setting is required. The root request `/` is handled by the application:

- New empty deployment + first-run setup enabled -> Super User setup page
- Existing configured deployment + signed out -> Login page
- Signed in -> Payment Board

After the first Super User is created, set `Security:AllowFirstRunSetup` to `false` in `appsettings.Production.json`.

## Database

The current package uses a self-contained LiteDB file at:

`App_Data\ackerman-payment-board.db`

Only the IIS application process accesses this file. Back up `App_Data` according to IT policy. If IT later specifies another database engine, the application storage layer can be replaced without redesigning the front-end workflow.

## Authentication roles

- **Super User**: standard application rights plus user creation, password resets, role changes, account enable/disable.
- **Standard User**: Finance and Front Desk currently have the same application rights.

Passwords are hashed; existing passwords cannot be viewed.


## LiteDB / IIS application-pool settings

Version 3.1.2 uses LiteDB **Direct** connection mode for IIS. This avoids the `Global\...Mutex` access error that can occur with LiteDB Shared mode under a low-privilege IIS application-pool identity.

For the `AckermanPaymentBoard` application pool:

- .NET CLR Version: **No Managed Code**
- Managed Pipeline Mode: **Integrated**
- Maximum Worker Processes: **1**
- Disable Overlapped Recycle: **True** (recommended for the embedded LiteDB deployment so two IIS worker processes do not briefly open the same database during recycling)

Grant `IIS AppPool\AckermanPaymentBoard` **Modify** permission on `App_Data` (and `logs` if stdout logging is temporarily enabled).

## Version 3.2 launch-data note

Version 3.2 no longer seeds fictional patients. When upgrading an existing test database, opening the Payment Board removes legacy patient records whose ID starts with `demo-` or MRN starts with `DEMO-`, while preserving application users and non-demo patient records. Preserve `App_Data` during upgrades so user accounts remain intact.
