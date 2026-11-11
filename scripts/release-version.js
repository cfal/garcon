import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const numericVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseTag(version) {
  if (typeof version !== 'string' || !numericVersion.test(version)) {
    throw new Error('package.json must declare a numeric MAJOR.MINOR.PATCH release version');
  }
  return `v${version}`;
}

export function validateReleaseVersion(documents, tag) {
  const version = documents.root.version;
  const expectedTag = releaseTag(version);
  const locked = documents.cargoLock.package.filter(entry => entry.name === 'garcon-native'
    && !Object.hasOwn(entry, 'source'));
  if (locked.length !== 1) throw new Error('Cargo.lock must contain exactly one local garcon-native package');
  for (const [name, actual] of [
    ['native/package.json', documents.native.version],
    ['native/src-tauri/Cargo.toml', documents.cargo.package.version],
    ['native/src-tauri/Cargo.lock', locked[0].version],
    ['bun.lock native workspace', documents.bunLock.workspaces.native.version],
  ]) {
    if (actual !== version) throw new Error(`${name} version ${actual} differs from package.json ${version}`);
  }
  if (documents.tauri.version !== '../../package.json') {
    throw new Error('Tauri must read its version from ../../package.json');
  }
  if (tag !== undefined && tag !== expectedTag) throw new Error(`Release tag must be ${expectedTag}, got ${tag}`);
  return version;
}

export async function readReleaseVersion(directory = root, tag) {
  const read = async path => readFile(resolve(directory, path), 'utf8');
  const [rootPackage, native, cargo, cargoLock, bunLock, tauri] = await Promise.all([
    read('package.json'), read('native/package.json'), read('native/src-tauri/Cargo.toml'),
    read('native/src-tauri/Cargo.lock'), read('bun.lock'), read('native/src-tauri/tauri.conf.json'),
  ]);
  return validateReleaseVersion({
    root: JSON.parse(rootPackage), native: JSON.parse(native), cargo: Bun.TOML.parse(cargo),
    cargoLock: Bun.TOML.parse(cargoLock), bunLock: Bun.JSON5.parse(bunLock), tauri: JSON.parse(tauri),
  }, tag);
}

if (import.meta.main) {
  if (process.argv.length > 3) throw new Error('Usage: bun scripts/release-version.js [tag]');
  console.log(await readReleaseVersion(root, process.argv[2]));
}
