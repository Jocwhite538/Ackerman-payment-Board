param(
    [string]$Runtime = "win-x64",
    [switch]$FrameworkDependent
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "Source\Ackerman.PaymentBoard\Ackerman.PaymentBoard.csproj"
$out = Join-Path $root "IIS_SITE_OUTPUT"
$zip = Join-Path $root "Ackerman_IIS_SITE_Version_3_3.zip"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw ".NET 8 SDK was not found. This build step is for a developer/CI machine, not the IIS deployment server."
}

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$args = @("publish", $project, "-c", "Release", "-r", $Runtime, "-o", $out, "/p:PublishSingleFile=false", "/p:PublishTrimmed=false")
if ($FrameworkDependent) {
    $args += "--self-contained"
    $args += "false"
} else {
    $args += "--self-contained"
    $args += "true"
}

Write-Host "Publishing IIS deployment folder..."
& dotnet @args
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

# Keep the database inside the application tree as requested by the current IT design.
New-Item -ItemType Directory -Path (Join-Path $out "App_Data") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $out "logs") -Force | Out-Null

# Copy the reviewed production settings explicitly.
Copy-Item (Join-Path $root "Source\Ackerman.PaymentBoard\appsettings.Production.json") (Join-Path $out "appsettings.Production.json") -Force

# Deployment marker for IT.
@"
ACKERMAN PATIENT PAYMENT BOARD - IIS DEPLOYMENT FOLDER
Version 3.3

This directory is the IIS physical path.
Do not run dotnet restore or dotnet publish on the IIS server.
Browse the application root URL; the app routes first-time setup/login automatically.
See the IT deployment guide supplied with the handoff package.
"@ | Set-Content (Join-Path $out "IIS_DEPLOY_README.txt") -Encoding UTF8

$required = @("web.config", "appsettings.json", "appsettings.Production.json")
foreach ($file in $required) {
    if (-not (Test-Path (Join-Path $out $file))) { throw "Published output is missing $file" }
}

# The protected application pages are intentionally outside wwwroot and are
# served by AppController. Validate them explicitly so a publish cannot
# silently produce a working login followed by /app 404 errors.
$appPages = @("index.html", "analytics.html", "completed.html")
foreach ($page in $appPages) {
    $pagePath = Join-Path $out (Join-Path "AppPages" $page)
    if (-not (Test-Path $pagePath)) { throw "Published output is missing AppPages\$page" }
}

# Version 3.3 saves patients one at a time and merges simultaneous edits in the
# browser. Without these scripts the board cannot save, so fail the build instead.
$assets = @("server-bridge.js", "patient-merge.js", "data.js", "board.js")
foreach ($asset in $assets) {
    $assetPath = Join-Path $out (Join-Path "wwwroot\assets" $asset)
    if (-not (Test-Path $assetPath)) { throw "Published output is missing wwwroot\assets\$asset" }
}

$exe = Get-ChildItem $out -Filter "Ackerman.PaymentBoard.exe" -ErrorAction SilentlyContinue
$dll = Get-ChildItem $out -Filter "Ackerman.PaymentBoard.dll" -ErrorAction SilentlyContinue
if (-not $exe -and -not $dll) { throw "Published output is missing the application executable/DLL." }

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip -CompressionLevel Optimal
Write-Host ""
Write-Host "SUCCESS"
Write-Host "IIS folder: $out"
Write-Host "IT-ready ZIP: $zip"
