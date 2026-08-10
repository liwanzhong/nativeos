# ============================================================
# NativeOS Android Build Script
# Builds a release APK (可直接安装手机) by default
# Usage:
#   .\build-android.ps1              # release APK (默认，可直接安装)
#   .\build-android.ps1 -Debug       # debug APK (开发调试用)
#   .\build-android.ps1 -Clean       # clean before build
# ============================================================

param(
    [switch]$Debug,
    [switch]$Clean,
    [switch]$ForceUpdate,
    [string]$UpdateBaseUrl = "https://oss.tofitit.com/app/android",
    [string]$MinSupportedVersionCode,
    [string[]]$ReleaseNotes = @()
)

$Root        = $PSScriptRoot
$AppDir      = Join-Path $Root "rn-app"
$AndroidDir  = Join-Path $AppDir "android"
$GradleExe   = Join-Path $AndroidDir "gradlew.bat"
$AppJsonPath = Join-Path $AppDir "app.json"

function Remove-PathIfExists {
    param(
        [string]$TargetPath
    )

    if (Test-Path $TargetPath) {
        try {
            Remove-Item $TargetPath -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Host "ERROR: Failed to remove stale build path: $TargetPath" -ForegroundColor Red
            Write-Host $_.Exception.Message -ForegroundColor Red
            exit 1
        }
    }
}

function Write-Utf8NoBomFile {
    param(
        [string]$TargetPath,
        [string]$Content
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($TargetPath, $Content, $utf8NoBom)
}

function Get-SourceMp4Files {
    return Get-ChildItem -Path $AppDir -Recurse -File -Filter *.mp4 -ErrorAction SilentlyContinue | Where-Object {
        $_.FullName -notlike (Join-Path $AndroidDir "app\build\*") -and
        $_.FullName -notlike (Join-Path $AppDir "node_modules\*")
    }
}

function Assert-NoSourceMp4Files {
    $mp4Files = @(Get-SourceMp4Files)
    if ($mp4Files.Count -gt 0) {
        Write-Host "" 
        Write-Host "ERROR: Detected local mp4 files that are not allowed to be packaged:" -ForegroundColor Red
        $mp4Files | ForEach-Object {
            Write-Host "  $($_.FullName)" -ForegroundColor Red
        }
        exit 1
    }
}

function Assert-ApkHasNoMp4 {
    param(
        [string]$ApkPath
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ApkPath)
    try {
        $mp4Entries = @($zip.Entries | Where-Object { $_.FullName -match '\\.mp4$' })
        if ($mp4Entries.Count -gt 0) {
            Write-Host "" 
            Write-Host "ERROR: APK contains forbidden mp4 resources:" -ForegroundColor Red
            $mp4Entries | ForEach-Object {
                Write-Host "  $($_.FullName)" -ForegroundColor Red
            }
            exit 1
        }
    }
    finally {
        $zip.Dispose()
    }
}

# ── Auto-increment patch version ──────────────────────────
$appJson     = Get-Content $AppJsonPath -Raw | ConvertFrom-Json
$oldVersion  = $appJson.expo.version
$oldVersionCode = [int]$appJson.expo.android.versionCode
$parts       = $oldVersion -split '\.'  # e.g. "1.0.0" -> ["1","0","0"]
$newPatch    = [int]$parts[2] + 1
$newVersion  = "$($parts[0]).$($parts[1]).$newPatch"
$newVersionCode = $oldVersionCode + 1
$appJson.expo.version = $newVersion
$appJson.expo.android.versionCode = $newVersionCode
$appJson | ConvertTo-Json -Depth 10 | Set-Content $AppJsonPath -Encoding UTF8
Write-Host "  Version: $oldVersion  →  $newVersion" -ForegroundColor Cyan
Write-Host "  VersionCode: $oldVersionCode  →  $newVersionCode" -ForegroundColor Cyan

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  NativeOS Android Build" -ForegroundColor Cyan
if ($Debug) {
    Write-Host "  Mode: DEBUG (APK)" -ForegroundColor Yellow
} else {
    Write-Host "  Mode: RELEASE APK (可直接安装)" -ForegroundColor Green
}
Write-Host "==================================================" -ForegroundColor Cyan

# ── Check prerequisites ───────────────────────────────────
if (-not (Test-Path $GradleExe)) {
    Write-Host ""
    Write-Host "ERROR: gradlew.bat not found at $GradleExe" -ForegroundColor Red
    Write-Host "Run 'npx expo prebuild --platform android' first to generate the Android project." -ForegroundColor Red
    exit 1
}

# ── Check node_modules ────────────────────────────────────
$nodeModules = Join-Path $AppDir "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host ""
    Write-Host "[0/3] Installing npm dependencies..." -ForegroundColor Yellow
    Set-Location $AppDir
    npm install
}

Assert-NoSourceMp4Files

Set-Location $AndroidDir
& $GradleExe --stop | Out-Null

$staleAssetPaths = @(
    (Join-Path $AndroidDir "app\build\generated"),
    (Join-Path $AndroidDir "app\build\intermediates\packaged_res"),
    (Join-Path $AndroidDir "app\build\intermediates\merged_res"),
    (Join-Path $AndroidDir "app\build\outputs\apk"),
    (Join-Path $AppDir "node_modules\.cache\metro")
)

foreach ($staleAssetPath in $staleAssetPaths) {
    Remove-PathIfExists -TargetPath $staleAssetPath
}

# ── Step 1: Optional clean ────────────────────────────────
if ($Clean) {
    Write-Host ""
    Write-Host "[1/3] Cleaning Android build cache..." -ForegroundColor Yellow
    Set-Location $AndroidDir
    & $GradleExe clean
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Clean failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "      Clean done." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[1/3] Skipping clean (use -Clean flag to clean first)." -ForegroundColor DarkGray
}

# ── Step 2: Bundle JS ─────────────────────────────────────
Write-Host ""
Write-Host "[2/3] Bundling JavaScript..." -ForegroundColor Yellow
Set-Location $AppDir

if ($Debug) {
    # Debug build bundles automatically via Metro at runtime
    Write-Host "      Debug mode: Metro bundles JS at runtime, skipping offline bundle." -ForegroundColor DarkGray
} else {
    # Release build bundles JS inline via Gradle (handled automatically by assembleRelease)
    Write-Host "      Release mode: JS bundle handled by Gradle assembleRelease." -ForegroundColor DarkGray
}

# ── Step 3: Gradle build ──────────────────────────────────
Write-Host ""
Set-Location $AndroidDir

if ($Debug) {
    Write-Host "[3/3] Building DEBUG APK (assembleDebug)..." -ForegroundColor Yellow
    & $GradleExe assembleDebug
    $outputPath = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"
} else {
    Write-Host "[3/3] Building RELEASE APK (assembleRelease)..." -ForegroundColor Yellow
    & $GradleExe assembleRelease
    $outputPath = Join-Path $AndroidDir "app\build\outputs\apk\release\app-release.apk"
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "BUILD FAILED. Check Gradle output above." -ForegroundColor Red
    exit 1
}

# ── Done ──────────────────────────────────────────────────
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  BUILD SUCCEEDED" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green

if (Test-Path $outputPath) {
    $size      = [math]::Round((Get-Item $outputPath).Length / 1MB, 1)
    # Rename APK with version number
    $apkDir    = Split-Path $outputPath -Parent
    if ($Debug) {
        $namedApk = Join-Path $apkDir "NativeOS-debug-v${newVersion}.apk"
    } else {
        $namedApk = Join-Path $apkDir "NativeOS-release-v${newVersion}.apk"
    }
    Copy-Item $outputPath $namedApk -Force
    Assert-ApkHasNoMp4 -ApkPath $namedApk
    $apkFileName = Split-Path $namedApk -Leaf
    $apkMd5 = (Get-FileHash -Path $namedApk -Algorithm MD5).Hash.ToLowerInvariant()
    $apkSizeBytes = (Get-Item $namedApk).Length
    $normalizedUpdateBaseUrl = $UpdateBaseUrl.TrimEnd('/')
    $versionManifest = [ordered]@{
        versionName = $newVersion
        versionCode = $newVersionCode
        downloadUrl = "$normalizedUpdateBaseUrl/$apkFileName"
        forceUpdate = [bool]$ForceUpdate
        releaseNotes = @($ReleaseNotes | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        apkMd5 = $apkMd5
        apkSizeBytes = $apkSizeBytes
        publishedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    }
    if (-not [string]::IsNullOrWhiteSpace($MinSupportedVersionCode)) {
        $versionManifest.minSupportedVersionCode = [int]$MinSupportedVersionCode
    }
    $versionJsonPath = Join-Path $apkDir "version.json"
    $versionJsonContent = $versionManifest | ConvertTo-Json -Depth 10
    Write-Utf8NoBomFile -TargetPath $versionJsonPath -Content $versionJsonContent
    Write-Host "  Output:  $namedApk" -ForegroundColor White
    Write-Host "  Manifest: $versionJsonPath" -ForegroundColor White
    Write-Host "  Version: $newVersion" -ForegroundColor Cyan
    Write-Host "  VersionCode: $newVersionCode" -ForegroundColor Cyan
    Write-Host "  Size:    ${size} MB" -ForegroundColor White
    $outputPath = $namedApk
} else {
    Write-Host "  Output file not found at expected path:" -ForegroundColor Yellow
    Write-Host "  $outputPath" -ForegroundColor Yellow
}

# ── Optional: install APK to connected device ───────────
if ($true) {
    Write-Host ""
    $install = 'n'
    # Read-Host throws PSInvalidOperationException in non-interactive mode
    # (e.g. when launched from a background scheduler without a TTY). Treat
    # that as "no, don't install" so the script can complete the build flow.
    try {
        if ([Environment]::UserInteractive) {
            $install = Read-Host "Install APK to connected device? (y/N)"
        } else {
            Write-Host "  (non-interactive mode, skipping install prompt)" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  (no TTY available, skipping install prompt)" -ForegroundColor DarkGray
    }
    if ($install -eq 'y' -or $install -eq 'Y') {
        $AdbExe = "D:\androidsdk\platform-tools\adb.exe"
        Write-Host "Installing APK..." -ForegroundColor Yellow
        & $AdbExe install -r $outputPath
        if ($LASTEXITCODE -eq 0) {
            Write-Host "APK installed successfully." -ForegroundColor Green
            Write-Host "Launching app..." -ForegroundColor Yellow
            & $AdbExe shell monkey -p com.nativeos.app -c android.intent.category.LAUNCHER 1
        } else {
            Write-Host "APK install failed." -ForegroundColor Red
        }
    }
}

Write-Host ""
