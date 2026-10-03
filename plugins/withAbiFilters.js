// Batasi ABI di APK. Library prebuilt (ML Kit, React Native) membawa x86/x86_64/armeabi-v7a
// yang tidak dipakai HP modern, sehingga APK membengkak (~93 MB -> ~30 MB untuk arm64 saja).
// Harus sama dengan reactNativeArchitectures saat build, supaya tidak ada ABI yang setengah jadi.
const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withAbiFilters(config, abis = ['arm64-v8a']) {
  return withAppBuildGradle(config, (cfg) => {
    const filter = `ndk { abiFilters ${abis.map((a) => `"${a}"`).join(', ')} }`;
    if (!cfg.modResults.contents.includes('abiFilters')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /defaultConfig\s*\{/,
        (m) => `${m}\n        ${filter}`,
      );
    }
    return cfg;
  });
};
