// Monorepo: resolve @mosipid/core straight from source.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.join(root, 'packages/core'), path.join(root, 'packages/mobile-kit')];
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];
config.resolver.extraNodeModules = { '@mosipid/core': path.join(root, 'packages/core/src'), '@mosipid/mobile-kit': path.join(root, 'packages/mobile-kit/src') };
module.exports = config;
