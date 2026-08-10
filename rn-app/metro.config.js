const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// dictionary.db 不再 bundle 进 app (按需从 OSS 下载)。
// 兜底: 防止有人不小心把 dictionary.db 拖回 assets/ 后被 metro 误打成 asset。
config.resolver.blockList = [
  ...(config.resolver.blockList ?? []),
  /assets\/dictionary\/dictionary\.db$/,
];

config.resolver.nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths || []),
  path.resolve(__dirname, 'node_modules'),
];

// Resolve platform-specific stubs on web
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'expo-sqlite') {
    return { type: 'empty' };
  }
  if (platform === 'web' && moduleName === 'react-native-worklets') {
    return { type: 'empty' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
