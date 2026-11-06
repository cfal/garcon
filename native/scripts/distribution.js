import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

export const targets = {
  'x86_64-unknown-linux-gnu': { formats: ['deb', 'appimage'], runtime: 'Linux synthetic WebView smoke', blockers: ['Package signing and update policy', 'Real Garcon workflow qualification'] },
  'x86_64-pc-windows-msvc': { formats: ['nsis'], runtime: 'Build only; interaction unverified', blockers: ['Authenticode certificate and timestamping', 'Windows interaction qualification', 'Update policy'] },
  'aarch64-apple-darwin': { formats: ['dmg'], runtime: 'Build only; interaction unverified', blockers: ['Developer ID signing and notarization', 'macOS interaction qualification', 'Update policy'] },
  'x86_64-apple-darwin': { formats: ['dmg'], runtime: 'Build only; interaction unverified', blockers: ['Developer ID signing and notarization', 'macOS interaction qualification', 'Update policy'] },
  android: { formats: ['apk'], runtime: 'Build-only launcher; connections disabled', blockers: ['Complete pre-load navigation guard', 'Stable keystore, alias, protected passwords, and pinned public signing-certificate SHA-256', 'Device workflow qualification and update policy', 'Store upload and mobile push are separate milestones'] },
  'ios-simulator': { formats: ['simulator'], runtime: 'Simulator launch/relaunch only; interaction unverified', blockers: ['Device build with matching team, distribution certificate, and provisioning profile', 'Device workflow qualification', 'TestFlight/App Store upload and mobile push are separate milestones'] },
};

const extensions = { deb: 'deb', appimage: 'AppImage', nsis: 'exe', dmg: 'dmg' };

export function releaseBlockers(target) {
  if (!Object.hasOwn(targets, target)) throw new Error(`Unknown distribution target: ${target}`);
  return targets[target].blockers;
}

export function checkContainer(format, head, tail) {
  const starts = bytes => head.subarray(0, bytes.length).equals(Buffer.from(bytes));
  const valid = {
    deb: () => starts('!<arch>\n'),
    appimage: () => starts([0x7f, 0x45, 0x4c, 0x46]) && head.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2])),
    nsis: () => starts('MZ'),
    dmg: () => tail.subarray(0, 4).equals(Buffer.from('koly')),
    apk: () => starts([0x50, 0x4b, 3, 4]),
    simulator: () => starts([0x50, 0x4b, 3, 4]),
  }[format];
  if (!valid?.()) throw new Error(`Invalid ${format} container`);
}

export function apkSignerFingerprint(output) {
  const lines = output.split(/\r?\n/);
  const counts = lines.filter(line => line.startsWith('Number of signers:'));
  const certificates = lines.filter(line => line.includes('certificate SHA-256 digest')
    && !/^Source Stamp Signer: certificate SHA-256 digest: [a-fA-F0-9]{64}$/.test(line));
  // Build Tools 37 uses scheme labels; rotation and hybrid identities need a richer manifest.
  const fingerprint = certificates.length === 1
    ? /^(?:V1|V2|V3\.0) Signer: certificate SHA-256 digest: ([a-fA-F0-9]{64})$/.exec(certificates[0])?.[1]
    : undefined;
  if (counts.length !== 1 || counts[0] !== 'Number of signers: 1' || !fingerprint) {
    throw new Error(`Expected exactly one verified APK signer certificate. apksigner output:\n${output}`);
  }
  return fingerprint.toLowerCase();
}

export async function inspectArtifact(path, format) {
  const info = await lstat(path);
  if (!info.isFile() || info.size < 512) throw new Error(`Not a nonempty regular artifact: ${path}`);
  const file = await open(path, 'r');
  const head = Buffer.alloc(16);
  const tail = Buffer.alloc(512);
  try {
    await file.read(head, 0, head.length, 0);
    await file.read(tail, 0, tail.length, info.size - tail.length);
  } finally { await file.close(); }
  checkContainer(format, head, tail);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { file: basename(path), bytes: info.size, sha256: hash.digest('hex'), format };
}

function command(args) {
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${args[0]} artifact validation failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function validateApk(path, version) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME is required to verify APK metadata and its debug signature');
  const buildTools = resolve(sdk, 'build-tools/37.0.0');
  const fingerprint = apkSignerFingerprint(command([resolve(buildTools, 'apksigner'), 'verify', '--verbose', '--print-certs', path]));
  const metadata = command([resolve(buildTools, 'aapt'), 'dump', 'badging', path]);
  if (!metadata.includes("package: name='com.garconcloud.garcon'") || !metadata.includes(`versionName='${version}'`)) {
    throw new Error('APK identity/version mismatch');
  }
  if (!metadata.includes('application-debuggable')) throw new Error('Expected a debug APK, not a distribution build');
  const entries = command(['unzip', '-Z1', path]).split('\n');
  for (const abi of ['arm64-v8a', 'x86_64']) {
    if (!entries.includes(`lib/${abi}/libgarcon_native.so`)) throw new Error(`APK missing ${abi} native host`);
  }
  return fingerprint;
}

export async function validateArtifacts(target) {
  releaseBlockers(target);
  const cargo = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve(root, 'src-tauri/target');
  const version = (await Bun.file(resolve(root, '../package.json')).json()).version;
  const artifacts = [];
  for (const format of targets[target].formats) {
    let pattern;
    if (format === 'apk') {
      pattern = 'src-tauri/gen/android/app/build/outputs/apk/universal/debug/*.apk';
    } else if (format === 'simulator') {
      pattern = 'artifacts/Garcon-simulator.app.zip';
    } else {
      pattern = `${relative(root, cargo).replaceAll('\\', '/')}/${target}/release/bundle/${format}/*.${extensions[format]}`;
    }
    const files = [...new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true })];
    if (files.length !== 1) throw new Error(`Expected exactly one ${format} artifact, found ${files.length}`);
    const artifact = await inspectArtifact(files[0], format);
    if (format === 'deb') {
      if (command(['dpkg-deb', '--field', files[0], 'Version']).trim() !== version
        || command(['dpkg-deb', '--field', files[0], 'Architecture']).trim() !== 'amd64') {
        throw new Error('Debian package version/architecture mismatch');
      }
      command(['dpkg-deb', '--contents', files[0]]);
    }
    if (format === 'dmg') command(['hdiutil', 'verify', files[0]]);
    if (format === 'apk') artifact.signerCertificateSha256 = validateApk(files[0], version);
    if (format === 'simulator') {
      command(['unzip', '-t', files[0]]);
      if (!command(['unzip', '-Z1', files[0]]).split('\n').includes('Garcon.app/Info.plist')) {
        throw new Error('Simulator archive is missing Garcon.app/Info.plist');
      }
    }
    artifacts.push(artifact);
  }
  const manifest = {
    schemaVersion: 1, target, version, distribution: 'preview-only', releaseAllowed: false,
    signing: target === 'android' ? 'ephemeral-debug-key-not-stable' : 'unsigned-not-distribution-verified',
    runtimeGate: targets[target].runtime,
    runtimeResult: 'not-attested-by-artifact-validation',
    releaseBlockers: releaseBlockers(target), artifacts,
  };
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await Bun.write(resolve(root, `artifacts/distribution-${target}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  const [intent, target, ...extra] = process.argv.slice(2);
  if (!['preview', 'release'].includes(intent) || !target || extra.length) {
    throw new Error('Usage: bun scripts/distribution.js <preview|release> <target>');
  }
  if (intent === 'release') throw new Error(`Release blocked for ${target}:\n- ${releaseBlockers(target).join('\n- ')}`);
  console.log(JSON.stringify(await validateArtifacts(target), null, 2));
}
