const fs = require('fs');
const Module = require('module');
const ts = require('typescript');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveTsFallback(request, parent, isMain, options) {
  try {
    return originalResolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    if (
      error &&
      error.code === 'MODULE_NOT_FOUND' &&
      typeof request === 'string' &&
      (request.startsWith('./') || request.startsWith('../'))
    ) {
      return originalResolveFilename.call(this, `${request}.ts`, parent, isMain, options);
    }
    throw error;
  }
};

require.extensions['.ts'] = function compileTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { runSpeechRegressionSuite } = require('../lib/ai/speech-regression.ts');

async function main() {
  const result = await runSpeechRegressionSuite();
  const summary = `[SpeechRegression] ${result.passed}/${result.total} passed`;

  if (result.failed === 0) {
    console.log(summary);
    process.exit(0);
  }

  console.error(summary);
  for (const failure of result.failures) {
    console.error(`- ${failure.name}`);
    console.error(`  ${failure.details}`);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error('[SpeechRegression] runner failed');
  console.error(error);
  process.exit(1);
});
