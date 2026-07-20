#!/usr/bin/env bun

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAgentBuildContributions } from './agent-build-metadata.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(repoRoot, 'web', 'build');
const executableDir = path.resolve(repoRoot, 'dist');
const executableTargets = {
  'linux-x64': { bunTarget: 'bun-linux-x64-baseline', outputName: 'garcon-linux-x64' },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', outputName: 'garcon-darwin-arm64' },
  'windows-x64': { bunTarget: 'bun-windows-x64-baseline', outputName: 'garcon-windows-x64.exe' },
};

async function listFilesRecursive(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function parseRequestedTargets(argv) {
  const targetArgs = argv.filter((argument) => argument.startsWith('--target='));
  if (targetArgs.length === 0) return Object.keys(executableTargets);
  const requested = targetArgs.flatMap((argument) => (
    argument.slice('--target='.length).split(',').map((value) => value.trim()).filter(Boolean)
  ));
  const invalid = requested.find((target) => !executableTargets[target]);
  if (invalid) {
    throw new Error(
      `Unsupported executable target "${invalid}". Supported targets: ${Object.keys(executableTargets).join(', ')}.`,
    );
  }
  return [...new Set(requested)];
}

async function collectEmbeddedAssetInputs() {
  const distStat = await fs.stat(distDir).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(`Missing web build output directory: ${distDir}. Run "bun run build" first.`);
  }
  const files = (await listFilesRecursive(distDir)).sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error(`web/build is empty: ${distDir}`);
  return files;
}

function createVirtualMainEntrypoint(
  assetsEntrypoint,
  serverMainPath,
  preMainModules,
  searchAssets,
) {
  const imports = searchAssets.entries.map((entry, index) => (
    `import searchAsset${index} from '${toPosixPath(entry.filePath)}' with { type: 'file' };`
  ));
  const integrationEntries = searchAssets.entries
    .filter((entry) => entry.kind === 'integration')
    .map((entry) => ({ entry, variable: `searchAsset${searchAssets.entries.indexOf(entry)}` }))
    .reduce((byIntegration, { entry, variable }) => {
      byIntegration[entry.integrationId] ??= {};
      byIntegration[entry.integrationId][entry.name] = variable;
      return byIntegration;
    }, {});
  const manifestExpression = `{
    mode: 'compiled',
    apiVersion: 1,
    workers: {
      indexer: searchAsset${searchAssets.entries.findIndex((entry) => entry.kind === 'worker' && entry.name === 'indexer')},
      reader: searchAsset${searchAssets.entries.findIndex((entry) => entry.kind === 'worker' && entry.name === 'reader')},
    },
    integrations: {${Object.entries(integrationEntries).map(([integrationId, entries]) => (
      `${JSON.stringify(integrationId)}:{${Object.entries(entries).map(([name, variable]) => `${JSON.stringify(name)}:${variable}`).join(',')}}`
    )).join(',')}}
  }`;
  return [
    `import '${assetsEntrypoint}';`,
    ...imports,
    ...preMainModules.map((modulePath) => `import '${toPosixPath(modulePath)}';`),
    `const deepFreeze = (value) => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value)) deepFreeze(nested); } return value; };`,
    `Object.defineProperty(globalThis, Symbol.for('garcon.compiled-mode'), { value: true, writable: false, configurable: false });`,
    `Object.defineProperty(globalThis, Symbol.for('garcon.embedded-search-manifest.v1'), { value: deepFreeze(${manifestExpression}), writable: false, configurable: false });`,
    `await import('${serverMainPath}');`,
    '',
  ].join('\n');
}

async function bundleStandaloneEntrypoints(contributions) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-agent-entrypoints-'));
  const files = [];
  const entries = [];
  try {
    for (const contribution of contributions) {
      for (const [name, entrypoint] of Object.entries(contribution.standaloneEntrypoints)) {
        const result = await Bun.build({
          entrypoints: [entrypoint],
          target: 'bun',
          format: 'esm',
          minify: true,
        });
        if (!result.success || result.outputs.length !== 1) {
          for (const log of result.logs) console.error(log);
          throw new Error(`Agent standalone entrypoint bundle failed: ${entrypoint}`);
        }
        const filePath = path.join(
          directory,
          `${contribution.integrationId}-${name}.js`,
        );
        await fs.writeFile(filePath, await result.outputs[0].arrayBuffer());
        files.push(filePath);
        entries.push({
          kind: 'integration',
          integrationId: contribution.integrationId,
          name,
          filePath,
        });
      }
    }
    for (const [name, entrypoint] of Object.entries({
      indexer: path.join(repoRoot, 'server-agents/common/src/search/indexer-main.ts'),
      reader: path.join(repoRoot, 'server-agents/common/src/search/reader-main.ts'),
    })) {
      const result = await Bun.build({ entrypoints: [entrypoint], target: 'bun', format: 'esm', minify: true });
      if (!result.success || result.outputs.length !== 1) {
        for (const log of result.logs) console.error(log);
        throw new Error(`Transcript search Worker bundle failed: ${name}`);
      }
      const filePath = path.join(directory, `transcript-search-${name}.js`);
      await fs.writeFile(filePath, await result.outputs[0].arrayBuffer());
      files.push(filePath);
      entries.push({ kind: 'worker', name, filePath });
    }
    return { directory, files, entries };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function buildExecutable(targetId, embeddedFiles, contributions, searchAssets) {
  const assetsEntrypoint = '__garcon_embed_static_assets__.js';
  const mainEntrypoint = '__garcon_build_exe_main__.js';
  const serverMainPath = toPosixPath(path.join(repoRoot, 'server', 'main.js'));
  const filesToEmbed = [
    ...embeddedFiles,
    ...contributions.flatMap((contribution) => contribution.embeddedDependencyMetadata),
  ];
  const assetImports = filesToEmbed.map((filePath) => (
    `import '${toPosixPath(filePath)}' with { type: 'file' };`
  ));
  const target = executableTargets[targetId];
  const outFile = path.resolve(executableDir, target.outputName);
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  const result = await Bun.build({
    entrypoints: [mainEntrypoint],
    compile: { target: target.bunTarget, outfile: outFile },
    naming: { asset: '[dir]/[name].[ext]' },
    files: {
      [assetsEntrypoint]: assetImports.join('\n'),
      [mainEntrypoint]: createVirtualMainEntrypoint(
        assetsEntrypoint,
        serverMainPath,
        contributions.flatMap((contribution) => contribution.preMainModules),
        searchAssets,
      ),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('Executable build failed.');
  }
  console.log(`Compiled ${target.outputName} with ${embeddedFiles.length} embedded assets.`);
}

async function run() {
  const targetIds = parseRequestedTargets(Bun.argv.slice(2));
  const embeddedFiles = await collectEmbeddedAssetInputs();
  const contributions = await collectAgentBuildContributions({ repoRoot });
  const agentAssets = await bundleStandaloneEntrypoints(contributions);
  try {
    const allEmbeddedFiles = [...embeddedFiles, ...agentAssets.files];
    for (const targetId of targetIds) {
      await buildExecutable(targetId, allEmbeddedFiles, contributions, agentAssets);
    }
  } finally {
    await fs.rm(agentAssets.directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
