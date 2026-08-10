const fs = require('fs');
const path = require('path');
const pluginSrc = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'withLive2DFix.js'), 'utf8');

const start = pluginSrc.indexOf('const INJECTION = ');
if (start < 0) {
  console.error('Could not find INJECTION start');
  process.exit(1);
}
const end = pluginSrc.indexOf("';", start);
if (end < 0) {
  console.error('Could not find INJECTION end');
  process.exit(1);
}
const injSection = pluginSrc.substring(start, end);
console.log('--- INJECTION starts (first 200) ---');
console.log(injSection.substring(0, 200));
console.log('--- INJECTION ends (last 300) ---');
console.log(injSection.substring(injSection.length - 300));
console.log('---');
console.log('contains "afterEvaluate {":', injSection.includes('afterEvaluate {'));
console.log('contains "android.sourceSets":', injSection.includes('android.sourceSets'));
console.log('contains "preBuild.dependsOn extractLive2DAars":', injSection.includes('preBuild.dependsOn extractLive2DAars'));
