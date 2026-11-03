# Ackerman Patient Payment Board — Version 3 IT Handoff

## Purpose

Internal application to improve communication between Finance and the Front Desk around patient financial responsibility and collections. Both groups currently use the same Standard User permissions.

## Proposed deployment

- IIS internal site
- HTTPS only
- ASP.NET Core 8
- self-contained application database (LiteDB provider included)
- authenticated users
- shared patient/payment/document data

## Roles

- **Standard User** — Finance and Front Desk; same operational rights
- **Super User** — same operational rights plus user creation, password resets, account enable/disable, role management, and security/admin audit history

## Data flow

Employee Browser → HTTPS → IIS / ASP.NET Core → Application Database

Browsers do not connect directly to the database.

## What IT needs to decide/confirm

- internal DNS/site name
- IIS server and app pool/service identity
- .NET 8 Hosting Bundle availability
- TLS certificate
- database/data path or alternate database provider
- file/database ACLs
- backup/restore approach
- password/session standards
- audit retention standard
- network restrictions
- production approval for patient information

## Build command

```powershell
cd src\Ackerman.PaymentBoard
dotnet restore
dotnet publish -c Release -o C:\Deploy\AckermanPaymentBoard
```

See `DEPLOYMENT_IIS.md` for the detailed deployment checklist.
