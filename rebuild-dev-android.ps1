param(
    [string]$DeviceSerial = "127.0.0.1:7555",
    [switch]$Clean,
    [switch]$SkipPrebuild
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$AppDir = Join-Path $Root "rn-app"
$AndroidDir = Join-Path $AppDir "android"
$GradleExe = Join-Path $AndroidDir "gradlew.bat"

# Force the build JDK. See dev-start.ps1 for the full rationale. Temurin
# 17 (NOT JDK 21 — that hits JvmVendorSpec.IBM_SEMERU bug under Gradle 9.0.0).
$BuildJdk = if ($env:NATIVEOS_JDK) { $env:NATIVEOS_JDK } else { "D:\Java\jdk-17.0.17+10" }
if (-not (Test-Path (Join-Path $BuildJdk "bin\javac.exe"))) {
    Write-Host "[FATAL] Build JDK not found at $BuildJdk — set NATIVEOS_JDK env var to override." -ForegroundColor Red
    exit 1
}
$env:JAVA_HOME = $BuildJdk
$env:PATH = "$BuildJdk\bin;$env:PATH"
Write-Host "[JDK]  Forced JAVA_HOME=$BuildJdk (for AGP jlink) and prepended its bin to PATH." -ForegroundColor DarkGray

if (-not (Test-Path $AppDir)) {
    Write-Host "rn-app not found: $AppDir" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $GradleExe)) {
    Write-Host "gradlew.bat not found: $GradleExe" -ForegroundColor Red
    exit 1
}

$adbCommand = Get-Command adb -ErrorAction SilentlyContinue
if ($null -eq $adbCommand) {
    $fallbackAdb = "D:\androidsdk\platform-tools\adb.exe"
    if (Test-Path $fallbackAdb) {
        $AdbExe = $fallbackAdb
    } else {
        Write-Host "adb not found in PATH and fallback path is missing." -ForegroundColor Red
        exit 1
    }
} else {
    $AdbExe = $adbCommand.Source
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " NativeOS Android DEV Rebuild" -ForegroundColor Cyan
Write-Host " AppDir:  $AppDir" -ForegroundColor DarkGray
Write-Host " Device:  $DeviceSerial" -ForegroundColor DarkGray
Write-Host "==========================================" -ForegroundColor Cyan

Set-Location $AppDir

if (-not (Test-Path (Join-Path $AppDir "node_modules"))) {
    Write-Host "[1/6] Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[1/6] Dependencies already installed." -ForegroundColor DarkGray
}

if (-not $SkipPrebuild) {
    Write-Host "[2/6] Syncing Expo native config to android/..." -ForegroundColor Yellow
    npx expo prebuild --platform android --no-install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "expo prebuild failed." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[2/6] Skipping expo prebuild." -ForegroundColor DarkGray
}

Set-Location $AndroidDir

if ($Clean) {
    Write-Host "[3/6] Cleaning Android build..." -ForegroundColor Yellow
    & $GradleExe clean
    if ($LASTEXITCODE -ne 0) {
        Write-Host "gradle clean failed." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[3/6] Skipping clean." -ForegroundColor DarkGray
}

Write-Host "[4/6] Building debug app..." -ForegroundColor Yellow
& $GradleExe assembleDebug
if ($LASTEXITCODE -ne 0) {
    Write-Host "assembleDebug failed." -ForegroundColor Red
    exit 1
}

$ApkPath = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $ApkPath)) {
    Write-Host "Debug APK not found: $ApkPath" -ForegroundColor Red
    exit 1
}

Write-Host "[5/6] Ensuring adb connection..." -ForegroundColor Yellow
& $AdbExe connect $DeviceSerial | Out-Null
& $AdbExe devices

Write-Host "[6/6] Installing debug APK to emulator..." -ForegroundColor Yellow
& $AdbExe -s $DeviceSerial install -r $ApkPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "adb install failed." -ForegroundColor Red
    exit 1
}

Write-Host "Launching app..." -ForegroundColor Yellow
& $AdbExe -s $DeviceSerial shell monkey -p com.nativeos.app -c android.intent.category.LAUNCHER 1 | Out-Null

Write-Host "==========================================" -ForegroundColor Green
Write-Host " DEV BUILD + INSTALL SUCCEEDED" -ForegroundColor Green
Write-Host " APK: $ApkPath" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Green
