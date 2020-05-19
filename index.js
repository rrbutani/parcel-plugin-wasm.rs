const fs = require('fs')

module.exports = function (bundler) {
  bundler.addAssetType('toml', require.resolve('./WASMbindgenAsset'))
  bundler.addAssetType('rs', require.resolve('./WASMbindgenAsset'))
}
