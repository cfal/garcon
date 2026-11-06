import { resolve } from 'node:path';

export function chooseSimulator(catalog) {
  const runtime = catalog.runtimes.filter(item => {
    const [major, minor = 0] = item.version.split('.').map(Number);
    return item.isAvailable && item.identifier.includes('.iOS-') && (major > 17 || (major === 17 && minor >= 4));
  }).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw new Error('No supported iOS simulator runtime installed');
  const deviceType = catalog.devicetypes.find(item => item.name.startsWith('iPhone')
    && runtime.supportedDeviceTypes?.some(supported => supported.identifier === item.identifier));
  if (!deviceType) throw new Error('No compatible iPhone simulator device type');
  return { runtime: runtime.identifier, deviceType: deviceType.identifier };
}

export function findSimulatorApp(root) {
  const apps = [...new Bun.Glob('src-tauri/gen/apple/build/**/*.app').scanSync({
    cwd: root, onlyFiles: false, absolute: true,
  })].filter(path => !path.includes('.xcarchive/') && path.endsWith('/Garcon.app'));
  if (apps.length !== 1) throw new Error(`Expected one exported simulator app, found ${apps.length}`);
  return apps[0];
}

export function validateSimulatorMetadata(info, version) {
  const platforms = info.CFBundleSupportedPlatforms;
  if (info.CFBundleIdentifier !== 'com.garconcloud.garcon' || info.CFBundleShortVersionString !== version
    || info.CFBundleExecutable !== 'Garcon' || !Array.isArray(platforms) || platforms.length !== 1
    || platforms[0] !== 'iPhoneSimulator') {
    throw new Error('Expected the matching Garcon simulator bundle, not an iPhone distribution app');
  }
}

export async function validateSimulatorApp(app, root) {
  const result = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', resolve(app, 'Info.plist')]);
  if (result.exitCode !== 0) throw new Error('Unable to read simulator Info.plist');
  const version = (await Bun.file(resolve(root, '../package.json')).json()).version;
  validateSimulatorMetadata(JSON.parse(result.stdout.toString()), version);
  const executable = resolve(app, 'Garcon');
  const build = Bun.spawnSync(['xcrun', 'vtool', '-show-build', executable]);
  if (build.exitCode !== 0 || !/platform IOSSIMULATOR\b/.test(build.stdout.toString()) || /platform IOS\b/.test(build.stdout.toString())) {
    throw new Error('Garcon executable is not an iOS simulator binary');
  }
}
