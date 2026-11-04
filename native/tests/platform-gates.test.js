import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { apkSignerFingerprint, checkContainer, inspectArtifact, releaseBlockers, targets } from '../scripts/distribution.js';
import { chooseSimulator, validateSimulatorMetadata } from '../scripts/ios-app.js';
import { instrumentGradle, prepareAndroidTests } from '../scripts/prepare-android-tests.js';

const root = resolve(import.meta.dir, '..');

async function temporary(run) {
  const parent = process.env.TMPDIR ?? resolve(homedir(), 'tmp');
  await mkdir(parent, { recursive: true });
  const path = await mkdtemp(resolve(parent, 'native-gate-'));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}

test('Android instrumentation survives regeneration without changing the production host', async () => {
  const source = 'plugins { id("com.android.application") }\nandroid { namespace = "com.garconcloud.garcon" }\n';
  expect(instrumentGradle(instrumentGradle(source))).toBe(instrumentGradle(source));
  expect(() => instrumentGradle('android { namespace = "another.app" }')).toThrow('Unexpected generated Android project');
  await temporary(async app => {
    await writeFile(resolve(app, 'build.gradle.kts'), source);
    await prepareAndroidTests(app);
    await prepareAndroidTests(app);
    expect(await readFile(resolve(app, 'build.gradle.kts'), 'utf8')).toBe(instrumentGradle(source));
    for (const [from, to] of [
      ['guard-tests.gradle.kts', 'guard-tests.gradle.kts'],
      ['NavigationBoundaryTest.kt', 'src/androidTest/java/com/garconcloud/garcon/NavigationBoundaryTest.kt'],
    ]) {
      expect(await readFile(resolve(app, to), 'utf8')).toBe(await readFile(resolve(root, 'android-tests', from), 'utf8'));
    }
  });
});

test('every preview target remains explicitly blocked for end-user distribution', () => {
  for (const target of Object.keys(targets)) expect(releaseBlockers(target).length).toBeGreaterThan(1);
  expect(releaseBlockers('android').join(' ')).toContain('Stable keystore');
  expect(() => releaseBlockers('__proto__')).toThrow('Unknown distribution target');
  const result = Bun.spawnSync(['bun', 'scripts/distribution.js', 'release', 'android'], { cwd: root });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Release blocked for android');
});

test('artifact preflight rejects empty, disguised, and symlinked artifacts and records exact SHA-256', async () => {
  await temporary(async directory => {
    const path = resolve(directory, 'synthetic.deb');
    await writeFile(path, '');
    await expect(inspectArtifact(path, 'deb')).rejects.toThrow('nonempty regular artifact');
    await writeFile(path, Buffer.alloc(1024));
    await expect(inspectArtifact(path, 'deb')).rejects.toThrow('Invalid deb container');
    const bytes = Buffer.alloc(1024);
    bytes.write('!<arch>\n');
    await writeFile(path, bytes);
    expect(await inspectArtifact(path, 'deb')).toEqual({ file: 'synthetic.deb', bytes: 1024, format: 'deb', sha256: createHash('sha256').update(bytes).digest('hex') });
    // Windows CI may lack symlink privileges; all platforms still reject non-regular files.
    await expect(inspectArtifact(directory, 'deb')).rejects.toThrow('nonempty regular artifact');
    if (process.platform !== 'win32') {
      const link = resolve(directory, 'link.deb');
      await symlink(path, link);
      await expect(inspectArtifact(link, 'deb')).rejects.toThrow('nonempty regular artifact');
    }
  });
});

test('container checks distinguish AppImage from ELF and DMG from arbitrary content', () => {
  const head = Buffer.alloc(16);
  const tail = Buffer.alloc(512);
  head.set([0x7f, 0x45, 0x4c, 0x46]);
  expect(() => checkContainer('appimage', head, tail)).toThrow();
  head.set([0x41, 0x49, 2], 8);
  checkContainer('appimage', head, tail);
  expect(() => checkContainer('dmg', head, tail)).toThrow();
  tail.write('koly');
  checkContainer('dmg', head, tail);
  for (const format of ['nsis', 'apk', 'simulator', 'unknown']) expect(() => checkContainer(format, head, tail)).toThrow();
  head.write('MZ');
  checkContainer('nsis', head, tail);
  head.set([0x50, 0x4b, 3, 4]);
  for (const format of ['apk', 'simulator']) checkContainer(format, head, tail);
});

test('APK manifests record only a complete, unambiguous public certificate fingerprint', () => {
  const certificate = `Signer #1 certificate SHA-256 digest: ${'AB'.repeat(32)}\n`;
  expect(apkSignerFingerprint(certificate)).toBe('ab'.repeat(32));
  for (const invalid of ['', certificate + certificate, 'Signer #1 certificate SHA-256 digest: truncated']) {
    expect(() => apkSignerFingerprint(invalid)).toThrow('exactly one');
  }
});

test('iOS archive admission rejects device apps and stale versions', () => {
  const valid = { CFBundleIdentifier: 'com.garconcloud.garcon', CFBundleShortVersionString: '0.3.4', CFBundleExecutable: 'Garcon', CFBundleSupportedPlatforms: ['iPhoneSimulator'] };
  validateSimulatorMetadata(valid, '0.3.4');
  for (const patch of [
    { CFBundleIdentifier: 'synthetic.other' }, { CFBundleShortVersionString: '0.0.0' },
    { CFBundleExecutable: 'Other' }, { CFBundleSupportedPlatforms: ['iPhoneOS'] },
    { CFBundleSupportedPlatforms: ['iPhoneSimulator', 'iPhoneOS'] }, { CFBundleSupportedPlatforms: undefined },
    { CFBundleSupportedPlatforms: { 0: 'iPhoneSimulator', length: 1 } },
  ]) expect(() => validateSimulatorMetadata({ ...valid, ...patch }, '0.3.4')).toThrow('simulator bundle');
});

test('simulator gate selects a supported iPhone type without using any existing device', () => {
  const makeRuntime = (version, isAvailable = true) => ({ version, isAvailable, identifier: `synthetic.iOS-${version}`, supportedDeviceTypes: [{ identifier: 'phone' }] });
  const catalog = {
    runtimes: [makeRuntime('17.3'), makeRuntime('17.4'), makeRuntime('17.10'), makeRuntime('26.1', false)],
    devicetypes: [{ identifier: 'other', name: 'iPhone unsupported' }, { identifier: 'phone', name: 'iPhone synthetic' }],
    devices: { ignored: [{ udid: 'existing-user-device' }] },
  };
  expect(chooseSimulator(catalog)).toEqual({ runtime: 'synthetic.iOS-17.10', deviceType: 'phone' });
  expect(() => chooseSimulator({ ...catalog, runtimes: [makeRuntime('17.3')] })).toThrow('No supported');
  expect(() => chooseSimulator({ ...catalog, devicetypes: [] })).toThrow('No compatible');
});

test('mobile safety and artifact gates precede uploads without signing secrets', async () => {
  const workflow = Bun.YAML.parse(await readFile(resolve(root, '../.github/workflows/native-app.yml'), 'utf8'));
  for (const job of Object.values(workflow.jobs)) {
    const steps = job.steps;
    const upload = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4');
    const validate = steps.findIndex(step => step.run?.includes('distribution preview'));
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(upload);
  }
  const android = workflow.jobs.android.steps;
  expect(android.find(step => step.name === 'Android fail-closed and callback-gap regressions').with.script).toContain('connectedUniversalDebugAndroidTest');
  expect(android.find(step => step.name === 'Prepare tracked Android safety tests').run).toContain('test:android:prepare');
  expect(workflow.jobs.ios.steps.find(step => step.name === 'Launch and relaunch in an isolated simulator').run).toContain('test:ios-launch');
});
