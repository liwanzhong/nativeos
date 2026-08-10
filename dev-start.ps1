# ============================================================
# NativeOS Dev Start Script
# Starts: Android emulator + Metro bundler
# Usage: .\dev-start.ps1
# ============================================================

$Root      = $PSScriptRoot
$AppDir    = Join-Path $Root "rn-app"
$AdbExe    = "D:\androidsdk\platform-tools\adb.exe"
$MuMuDevice = "127.0.0.1:7555"

# Force the build JDK to Temurin 17. AGP's JdkImageTransform spawns jlink
# via JAVA_HOME (not via org.gradle.java.home), so the user-level JAVA_HOME
# must point at a JDK whose jlink understands AGP's --disable-plugin
# system-modules flag. Temurin 17.0.17 works; **JDK 21 hits a Gradle
# 9.0.0 + JvmVendorSpec.IBM_SEMERU compatibility bug during build script
# evaluation** so we don't use it. Override with NATIVEOS_JDK env var if
# you want a different one.
$BuildJdk = if ($env:NATIVEOS_JDK) { $env:NATIVEOS_JDK } else { "D:\Java\jdk-17.0.17+10" }
if (-not (Test-Path (Join-Path $BuildJdk "bin\javac.exe"))) {
    Write-Host "[FATAL] Build JDK not found at $BuildJdk — set NATIVEOS_JDK env var to override." -ForegroundColor Red
    exit 1
}
$env:JAVA_HOME = $BuildJdk
$env:PATH = "$BuildJdk\bin;$env:PATH"
Write-Host "[JDK]  Forced JAVA_HOME=$BuildJdk (for AGP jlink) and prepended its bin to PATH." -ForegroundColor DarkGray

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  NativeOS Dev Start" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

function Get-TargetDevice {
    $lines = & $AdbExe devices 2>&1 | Select-String "^$([regex]::Escape($MuMuDevice))\tdevice$"
    if (-not $lines) { return $null }
    return $lines[0].ToString().Split("`t")[0].Trim()
}

# ── Step 1: Connect MuMu emulator ────────────────────────
Write-Host ""
Write-Host "[1/3] Connecting MuMu emulator ($MuMuDevice)..." -ForegroundColor Yellow

& $AdbExe connect $MuMuDevice 2>&1 | Out-Null
Start-Sleep -Seconds 1

$targetDevice = Get-TargetDevice
if ($targetDevice) {
    Write-Host "      MuMu emulator connected on $targetDevice." -ForegroundColor Green
} else {
    Write-Host "      MuMu emulator $MuMuDevice is unavailable. Start MuMu manually and retry." -ForegroundColor Red
}

function Install-AndReverse {
    param($ApkPath, $Label)
    $dev = Get-TargetDevice
    if ($dev) {
        & $AdbExe -s $dev install -r $ApkPath | Out-Null
        Write-Host "      $Label installed on $dev." -ForegroundColor Green
        & $AdbExe -s $dev reverse tcp:8081 tcp:8081 | Out-Null
        Write-Host "      adb reverse tcp:8081 set on $dev." -ForegroundColor Green
    } else {
        Write-Host "      No device found, skipping APK install." -ForegroundColor DarkGray
    }
}

# ── Step 2: Install debug APK + adb reverse ──────────────
Write-Host ""
Write-Host "[2/3] Installing debug APK on MuMu emulator..." -ForegroundColor Yellow

$DebugApk = Join-Path $AppDir "android\app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path $DebugApk) {
    Install-AndReverse -ApkPath $DebugApk -Label "APK"
} else {
    Write-Host "      debug APK not found, building now (this may take a few minutes)..." -ForegroundColor Yellow
    $AndroidDir = Join-Path $AppDir "android"
    Push-Location $AndroidDir
    & ".\gradlew.bat" assembleDebug
    $buildExit = $LASTEXITCODE
    Pop-Location

    if ($buildExit -eq 0 -and (Test-Path $DebugApk)) {
        Install-AndReverse -ApkPath $DebugApk -Label "APK (freshly built)"
    } else {
        Write-Host "      Build failed. Check the output above for errors." -ForegroundColor Red
    }
}

# ── Step 3: Start Metro bundler (dev-client, no Expo Go) ─
Write-Host ""
Write-Host "[3/3] Starting Metro bundler (--dev-client, no Expo Go download)..." -ForegroundColor Yellow

# Kill any process already using port 8081 so Metro doesn't prompt
try {
    $port8081Procs = Get-NetTCPConnection -LocalPort 8081 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pid8081 in $port8081Procs) {
        if ($pid8081 -and $pid8081 -ne 0) {
            Stop-Process -Id $pid8081 -Force -ErrorAction SilentlyContinue
            Write-Host "      Killed process $pid8081 occupying port 8081." -ForegroundColor DarkGray
        }
    }
    if ($port8081Procs) { Start-Sleep -Seconds 1 }
} catch {}

# Re-run adb reverse so the newly started Metro is reachable
$dev2 = Get-TargetDevice
if ($dev2) {
    & $AdbExe -s $dev2 reverse tcp:8081 tcp:8081 2>&1 | Out-Null
    Write-Host "      adb reverse tcp:8081 refreshed on $dev2." -ForegroundColor Green
}

Write-Host ""
Write-Host "      Metro will open in this window. Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $AppDir
npx expo start --dev-client --port 8081
