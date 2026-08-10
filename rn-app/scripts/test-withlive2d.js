// Quick test: load the plugin and verify the injection text is what we expect.
const fs = require('fs');
const path = require('path');

const pluginSrc = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'withLive2DFix.js'), 'utf8');

// Find the MARKER constant
const markerMatch = pluginSrc.match(/const MARKER = '([^']+)'/);
if (!markerMatch) {
  console.error('FAIL: MARKER not found');
  process.exit(1);
}
const marker = markerMatch[1];
console.log('marker:', JSON.stringify(marker));
console.log('marker length:', marker.length);

// Find the INJECTION constant and extract its content
// It's a series of string concatenations after `const INJECTION = MARKER + '\n' +`
const injStart = pluginSrc.indexOf('const INJECTION = ');
const injEnd = pluginSrc.indexOf(';', pluginSrc.indexOf("' +'preBuild.dependsOn extractLive2DModels\\n';"));
if (injStart < 0 || injEnd < 0) {
  // fall back: just grep for the strings we expect
  const expects = [
    'tasks.register("extractLive2DAars")',
    'tasks.register("extractLive2DModels")',
    'def live2dProjectRoot',
    'preBuild.dependsOn extractLive2DAars',
    'preBuild.dependsOn extractLive2DModels',
    'afterEvaluate',
    'jniLibs.srcDirs',
    'assets.srcDirs',
    'implementation fileTree(dir: live2dGeneratedLibsDir',
  ];
  let allFound = true;
  for (const s of expects) {
    if (!pluginSrc.includes(s)) {
      console.error('FAIL: missing', s);
      allFound = false;
    } else {
      console.log('OK:', s);
    }
  }
  process.exit(allFound ? 0 : 1);
}

// Try to require the plugin to get the actual INJECTION string
// (it's not exported, so we'll just eval the file in a sandbox)
try {
  const p = require(path.join(__dirname, '..', 'plugins', 'withLive2DFix.js'));
  console.log('plugin module exports:', Object.keys(p));
  console.log('MARKER (re-import):', JSON.stringify(p.MARKER));
} catch (e) {
  console.error('FAIL to require plugin:', e.message);
  process.exit(1);
}
