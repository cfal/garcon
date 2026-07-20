import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../common/json.js';

const PROVIDER_PACKAGE_PATTERN = /^@garcon\/server-agent-(?!interface$|common$)[a-z0-9-]+$/;

export async function collectAgentBuildContributions(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.join(import.meta.dir, '..'));
  const serverPackagePath = path.resolve(
    options.serverPackagePath ?? path.join(repoRoot, 'server', 'package.json'),
  );
  const serverPackage = await readJson(serverPackagePath);
  const dependencies = serverPackage.dependencies ?? {};
  const packageNames = Object.keys(dependencies)
    .filter((name) => PROVIDER_PACKAGE_PATTERN.test(name))
    .sort();
  const seenIntegrationIds = new Set();
  const contributions = [];

  for (const packageName of packageNames) {
    const packageRoot = await resolvePackageRoot(
      packageName,
      path.dirname(serverPackagePath),
    );
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = await readJson(packageJsonPath);
    if (packageJson.name !== packageName) {
      throw new Error(`Resolved agent package manifest mismatch: ${packageName}`);
    }
    const metadata = validateBuildMetadata(packageName, packageJson.garconBuild);
    if (seenIntegrationIds.has(metadata.integrationId)) {
      throw new Error(`Duplicate agent build integration ID: ${metadata.integrationId}`);
    }
    seenIntegrationIds.add(metadata.integrationId);

    const standaloneEntrypoints = await resolveNamedPackageFiles(
      packageName,
      packageRoot,
      metadata.standaloneEntrypoints,
    );
    const preMainModules = await resolvePackageFiles(
      packageName,
      packageRoot,
      metadata.preMainModules,
    );
    const embeddedDependencyMetadata = [];
    for (const dependencyMetadata of metadata.embeddedDependencyMetadata) {
      const dependencyName = packageNameFromMetadataSpecifier(dependencyMetadata);
      if (!packageJson.dependencies?.[dependencyName]) {
        throw new Error(
          `${packageName} build metadata references undeclared dependency ${dependencyName}`,
        );
      }
      const dependencyRoot = await resolvePackageRoot(dependencyName, packageRoot);
      const metadataPath = await checkedPackageFile(
        packageName,
        dependencyRoot,
        'package.json',
      );
      embeddedDependencyMetadata.push(metadataPath);
    }

    contributions.push(Object.freeze({
      packageName,
      packageRoot,
      integrationId: metadata.integrationId,
      standaloneEntrypoints,
      preMainModules,
      embeddedDependencyMetadata,
    }));
  }
  return contributions;
}

async function resolvePackageRoot(packageName, fromDirectory) {
  let resolved;
  try {
    resolved = Bun.resolveSync(packageName, fromDirectory);
  } catch (error) {
    throw new Error(`Unable to resolve agent package ${packageName}`, { cause: error });
  }
  let current = path.dirname(await realpath(resolved));
  while (true) {
    const manifestPath = path.join(current, 'package.json');
    const manifest = await readJson(manifestPath).catch(() => null);
    if (manifest?.name === packageName) return realpath(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to locate matching package manifest for ${packageName}`);
}

function validateBuildMetadata(packageName, value) {
  if (!isRecord(value) || value.apiVersion !== 2) {
    throw new Error(`${packageName} has missing or unsupported garconBuild metadata`);
  }
  if (typeof value.integrationId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.integrationId)) {
    throw new Error(`${packageName} has an invalid garconBuild integrationId`);
  }
  return {
    integrationId: value.integrationId,
    standaloneEntrypoints: stringRecord(
      packageName,
      'standaloneEntrypoints',
      value.standaloneEntrypoints,
    ),
    preMainModules: stringArray(packageName, 'preMainModules', value.preMainModules),
    embeddedDependencyMetadata: stringArray(
      packageName,
      'embeddedDependencyMetadata',
      value.embeddedDependencyMetadata,
    ),
  };
}

function stringRecord(packageName, field, value) {
  if (!isRecord(value)) {
    throw new Error(`${packageName} garconBuild.${field} must be a string record`);
  }
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || typeof entry !== 'string') {
      throw new Error(`${packageName} garconBuild.${field} has an invalid entry`);
    }
    result[name] = entry;
  }
  if (typeof result['transcript-index-source'] !== 'string') {
    throw new Error(`${packageName} garconBuild.${field} is missing transcript-index-source`);
  }
  return result;
}

function stringArray(packageName, field, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${packageName} garconBuild.${field} must be a string array`);
  }
  return [...new Set(value)];
}

async function resolvePackageFiles(packageName, packageRoot, relativePaths) {
  return Promise.all(relativePaths.map(async (relativePath) => {
    if (!relativePath.startsWith('./')) {
      throw new Error(`${packageName} build contribution must be package-relative: ${relativePath}`);
    }
    return checkedPackageFile(packageName, packageRoot, relativePath.slice(2));
  }));
}

async function resolveNamedPackageFiles(packageName, packageRoot, relativePaths) {
  return Object.fromEntries(await Promise.all(Object.entries(relativePaths).map(async ([name, relativePath]) => {
    if (!relativePath.startsWith('./')) {
      throw new Error(`${packageName} build contribution must be package-relative: ${relativePath}`);
    }
    return [name, await checkedPackageFile(packageName, packageRoot, relativePath.slice(2))];
  })));
}

async function checkedPackageFile(packageName, packageRoot, relativePath) {
  const realRoot = await realpath(packageRoot);
  const candidate = await realpath(path.resolve(realRoot, relativePath)).catch(() => null);
  if (!candidate) throw new Error(`${packageName} build contribution does not exist: ${relativePath}`);
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${packageName} build contribution escapes its package: ${relativePath}`);
  }
  const fileStat = await stat(candidate);
  if (!fileStat.isFile()) throw new Error(`${packageName} build contribution is not a file: ${relativePath}`);
  return candidate;
}

function packageNameFromMetadataSpecifier(specifier) {
  const match = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)\/package\.json$/);
  if (!match) throw new Error(`Invalid embedded dependency metadata specifier: ${specifier}`);
  return match[1];
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}
