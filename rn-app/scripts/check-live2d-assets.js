// Smoke test: after a build, verify the Live2D model file landed at the
// correct path in the APK. Run: `node scripts/check-live2d-assets.js`
//
// Looks for the model file in two places:
//   1. $buildDir/generated/live2d-assets/models/senko/senko.model3.json  (preBuild output)
//   2. <apk_unpacked>/assets/models/senko/senko.model3.json              (final APK path)
//
// Prints PASS / FAIL with the actual paths it found.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const APP_BUILD = path.join(ANDROID, 'app', 'build');
const PREBUILT_ASSETS = path.join(APP_BUILD, 'generated', 'live2d-assets', 'models', 'senko', 'senko.model3.json');
const APK = path.join(APP_BUILD, 'outputs', 'apk', 'debug', 'app-debug.apk');

function check(label, p) {
  const exists = fs.existsSync(p);
  const status = exists ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${label}`);
  console.log(`        ${p}`);
  if (exists && fs.statSync(p).isFile()) {
    console.log(`        size = ${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`);
  }
  return exists;
}

console.log('--- preBuild output ---');
const preOk = check('preBuild task output', PREBUILT_ASSETS);

console.log('\n--- APK contents ---');
const apkExists = fs.existsSync(APK);
if (!apkExists) {
  console.log('[SKIP] app-debug.apk not found at:');
  console.log('       ' + APK);
  process.exit(preOk ? 0 : 1);
}

const APK_ASSET = 'assets/models/senko/senko.model3.json';
let apkOk = false;

// Try multiple ways to list APK contents (cross-platform friendly).
//   1. `unzip -l`         (Git Bash, WSL)
//   2. PowerShell's       `Expand-Archive` + Get-ChildItem
//   3. aapt dump            (slowest, but always works on Android SDK)
function listApkEntries() {
  // 1. try unzip
  const r1 = spawnSync('unzip', ['-l', APK], { encoding: 'utf8' });
  if (r1.status === 0) return r1.stdout;
  // 2. try PowerShell
  const r2 = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${APK.replace(/'/g, "''")}'); ` +
    `$zip.Entries | Where-Object { $_.FullName -like 'assets/*' } | Select-Object -ExpandProperty FullName; ` +
    `$zip.Dispose()`,
  ], { encoding: 'utf8' });
  if (r2.status === 0) return r2.stdout;
  // 3. try aapt (in Android SDK)
  const aapt = process.env.ANDROID_HOME
    ? path.join(process.env.ANDROID_HOME, 'build-tools')
    : 'D:/androidsdk/build-tools';
  let aaptExe = null;
  try {
    aaptExe = fs.readdirSync(aapt).reverse().find(d => /\d+\.\d+\.\d+/.test(d));
    if (aaptExe) aaptExe = path.join(aapt, aaptExe, 'aapt.exe');
  } catch { /* ignore */ }
  if (aaptExe && fs.existsSync(aaptExe)) {
    const r3 = spawnSync(aaptExe, ['list', APK], { encoding: 'utf8' });
    if (r3.status === 0) return r3.stdout;
  }
  return null;
}

const list = listApkEntries();
if (list === null) {
  console.log('[SKIP] could not list APK (no unzip / PowerShell / aapt available)');
} else {
  const found = list.split('\n').find(line => line.includes(APK_ASSET));
  if (found) {
    console.log('[PASS] APK contains the model file at the expected path');
    console.log('        ' + APK_ASSET);
    console.log('        ' + found.trim().split(/\s+/).slice(0, 3).join(' '));
    apkOk = true;
  } else {
    console.log('[FAIL] APK does NOT contain ' + APK_ASSET);
    console.log('        (this is why the avatar shows the emoji fallback)');
    const assetLines = list.split('\n').filter(l => l.includes('assets/')).slice(0, 10);
    console.log('        first 10 asset entries:');
    assetLines.forEach(l => console.log('          ' + l.trim()));
  }
}

console.log('\n--- summary ---');
if (preOk && apkOk) {
  console.log('OK — Live2D assets look right.');
  process.exit(0);
}
if (preOk && !apkOk) {
  console.log('WARN — preBuild output exists but APK is missing the asset.');
  console.log('       Try a clean rebuild: `cd android && ./gradlew.bat clean assembleDebug`');
  process.exit(2);
}
console.log('FAIL — preBuild task did not produce the model file. Check the preBuild task in android/app/build.gradle (or plugins/withLive2DFix.js).');
process.exit(1);
