# ============================================================
# NativeOS 首次初始化脚本
# 新开发者 git clone 后执行一次即可
# 用法: .\setup.ps1
# 可选参数:
#   -MuMuDevice  "127.0.0.1:7555"  MuMu ADB 地址（默认 7555）
#   -JavaHome    "D:\Java\jdk-..."  JDK 17 路径（默认读 NATIVEOS_JDK 环境变量）
#   -SkipBuild                      跳过首次编译（只做依赖安装）
# ============================================================

param(
    [string]$MuMuDevice = "127.0.0.1:7555",
    [string]$JavaHome   = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root      = $PSScriptRoot
$AppDir    = Join-Path $Root "rn-app"
$AndroidDir= Join-Path $AppDir "android"
$DocsDir   = Join-Path $Root "docs"

# ── 工具函数 ─────────────────────────────────────────────────
function Step { param($n, $total, $msg, $color="Yellow")
    Write-Host ""
    Write-Host "[$n/$total] $msg" -ForegroundColor $color
}
function OK   { param($msg) Write-Host "      ✔ $msg" -ForegroundColor Green }
function WARN { param($msg) Write-Host "      ⚠ $msg" -ForegroundColor DarkYellow }
function FAIL { param($msg) Write-Host "      ✘ $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  NativeOS 首次初始化" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ── Step 1: 检查 JDK 17 ──────────────────────────────────────
Step 1 6 "检查 JDK 17..."
$jdk = if ($JavaHome) { $JavaHome }
       elseif ($env:NATIVEOS_JDK) { $env:NATIVEOS_JDK }
       else { "D:\Java\jdk-17.0.17+10" }

if (-not (Test-Path (Join-Path $jdk "bin\javac.exe"))) {
    FAIL "JDK 17 未找到: $jdk`n      请安装 Temurin 17 (https://adoptium.net) 后设置环境变量 NATIVEOS_JDK=<路径>"
}
$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"
OK "JAVA_HOME = $jdk"

# ── Step 2: 检查 ADB ─────────────────────────────────────────
Step 2 6 "检查 ADB..."
$adbExe = ""
$adbCmd = Get-Command adb -ErrorAction SilentlyContinue
if ($adbCmd) {
    $adbExe = $adbCmd.Source
} elseif (Test-Path "D:\androidsdk\platform-tools\adb.exe") {
    $adbExe = "D:\androidsdk\platform-tools\adb.exe"
    $env:PATH = "D:\androidsdk\platform-tools;$env:PATH"
} else {
    FAIL "adb 未找到。请安装 Android SDK Platform-Tools 并添加到 PATH，或将 SDK 放到 D:\androidsdk"
}
OK "adb = $adbExe"

# ── Step 3: 检查本地 tgz 包 ──────────────────────────────────
Step 3 6 "检查本地依赖包 react-native-live2d..."
$tgzPath = Join-Path $DocsDir "react-native-live2d-0.1.0.tgz"
if (-not (Test-Path $tgzPath)) {
    FAIL "缺少文件: $tgzPath`n      请从团队共享存储获取该文件并放到 docs/ 目录"
}
OK "react-native-live2d-0.1.0.tgz 存在"

# ── Step 4: 检查 .env.local ───────────────────────────────────
Step 4 6 "检查环境变量配置..."
$envFile = Join-Path $AppDir ".env.local"
if (-not (Test-Path $envFile)) {
    WARN ".env.local 不存在，正在从模板创建..."
    $template = @"
# ⚠ 请填写以下值，否则 AI 功能无法使用
EXPO_PUBLIC_QWEN_API_KEY=
ALIBABA_API_KEY=
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
"@
    $template | Out-File -FilePath $envFile -Encoding UTF8
    WARN ".env.local 已创建（模板），请填写 API Key 后再继续"
    WARN "填写完毕后重新运行 .\setup.ps1 或直接运行 .\dev-start.ps1"
} else {
    OK ".env.local 已存在"
}

# ── Step 5: npm install ───────────────────────────────────────
Step 5 6 "安装 npm 依赖..."
Set-Location $AppDir

npm install
if ($LASTEXITCODE -ne 0) { FAIL "npm install 失败" }

# 验证 react-native-live2d 是否成功安装到顶层
if (-not (Test-Path (Join-Path $AppDir "node_modules\react-native-live2d"))) {
    FAIL "react-native-live2d 未安装到 node_modules，请检查 docs/react-native-live2d-0.1.0.tgz 是否完整"
}

# 验证 babel-preset-expo 是否在顶层（版本号历史上曾写错过）
if (-not (Test-Path (Join-Path $AppDir "node_modules\babel-preset-expo"))) {
    WARN "babel-preset-expo 不在顶层 node_modules，正在修复..."
    npm install --save-dev babel-preset-expo@55.0.24
    if ($LASTEXITCODE -ne 0) { FAIL "babel-preset-expo 安装失败" }
}

OK "npm 依赖安装完成"

# ── Step 6: 编译 APK 并安装到 MuMu ───────────────────────────
Step 6 6 "编译 Debug APK 并安装到 MuMu..."

if ($SkipBuild) {
    WARN "已跳过编译（-SkipBuild），请手动运行 .\rebuild-dev-android.ps1"
} else {
    # 连接 MuMu
    & $adbExe connect $MuMuDevice 2>&1 | Out-Null
    Start-Sleep -Seconds 1
    $deviceLine = & $adbExe devices | Select-String $MuMuDevice
    if (-not $deviceLine) {
        WARN "MuMu 模拟器未连接 ($MuMuDevice)，编译后需手动安装"
        WARN "请启动 MuMu 后运行: adb connect $MuMuDevice，再运行 .\dev-start.ps1"
    }

    Set-Location $AndroidDir
    & ".\gradlew.bat" assembleDebug
    if ($LASTEXITCODE -ne 0) { FAIL "assembleDebug 编译失败，请检查上方 Gradle 日志" }

    $apk = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"
    if (-not (Test-Path $apk)) { FAIL "APK 未生成: $apk" }
    OK "APK 编译成功: $apk"

    if ($deviceLine) {
        & $adbExe -s $MuMuDevice install -r $apk
        if ($LASTEXITCODE -ne 0) { FAIL "APK 安装失败" }
        & $adbExe -s $MuMuDevice reverse tcp:8081 tcp:8081 | Out-Null
        OK "APK 已安装到 $MuMuDevice，adb reverse 已设置"
    }
}

# ── 完成 ─────────────────────────────────────────────────────
Set-Location $Root
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  初始化完成！" -ForegroundColor Green
Write-Host "  日常开发请运行: .\dev-start.ps1" -ForegroundColor White
Write-Host "  重新编译原生请: .\rebuild-dev-android.ps1" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Green
