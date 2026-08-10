const createExpoWebpackConfigAsync = require('@expo/webpack-config');

module.exports = async function (env, argv) {
  const config = await createExpoWebpackConfigAsync(
    {
      ...env,
      babel: {
        dangerouslyAddModulePathsToTranspile: ['expo-sqlite'],
      },
    },
    argv
  );

  // Add WASM support
  config.resolve.extensions.push('.wasm');
  
  config.module.rules.push({
    test: /\.wasm$/,
    type: 'webassembly/async',
  });

  // Enable WebAssembly experiments
  config.experiments = {
    ...config.experiments,
    asyncWebAssembly: true,
  };

  return config;
};
