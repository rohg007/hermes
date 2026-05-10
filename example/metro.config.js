const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const exclusionList = require('metro-config/private/defaults/exclusionList').default;

const root = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);
const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedExample = __dirname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = mergeConfig(config, {
  watchFolders: [root],
  resolver: {
    blockList: exclusionList([
      new RegExp(`${escapedRoot}/node_modules/react/.*`),
      new RegExp(`${escapedRoot}/node_modules/react-native/.*`),
      new RegExp(`${escapedExample}/node_modules/@bitnet/react-native/node_modules/react/.*`),
      new RegExp(`${escapedExample}/node_modules/@bitnet/react-native/node_modules/react-native/.*`),
    ]),
    extraNodeModules: {
      '@bitnet/react-native': root,
      react: path.join(__dirname, 'node_modules/react'),
      'react-native': path.join(__dirname, 'node_modules/react-native'),
    },
  },
});
