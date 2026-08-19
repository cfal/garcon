#!/usr/bin/env bun

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAgentBuildContributions } from './agent-build-metadata.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(repoRoot, 'web', 'build');
const executableDir = path.resolve(repoRoot, 'dist');
const executableTargets = {
  'linux-x64': {
    bunTarget: 'bun-linux-x64-baseline',
    executablePathEnvironment: 'GARCON_BUN_COMPILE_LINUX_X64_EXECUTABLE',
    outputName: 'garcon-linux-x64',
    cliOutputName: 'garcon-cli-linux-x64',
  },
  'darwin-arm64': {
    bunTarget: 'bun-darwin-arm64',
    executablePathEnvironment: 'GARCON_BUN_COMPILE_DARWIN_ARM64_EXECUTABLE',
    outputName: 'garcon-darwin-arm64',
    cliOutputName: 'garcon-cli-darwin-arm64',
  },
  'windows-x64': {
    bunTarget: 'bun-windows-x64-baseline',
    executablePathEnvironment: 'GARCON_BUN_COMPILE_WINDOWS_X64_EXECUTABLE',
    outputName: 'garcon-windows-x64.exe',
  },
};

export function compileOptionsForTarget(targetId, outfile, environment = process.env) {
  const target = executableTargets[targetId];
  if (!target) throw new Error(`Unsupported executable target "${targetId}".`);
  const configuredExecutablePath = environment[target.executablePathEnvironment]?.trim();
  return {
    target: target.bunTarget,
    outfile,
    ...(configuredExecutablePath
      ? { executablePath: path.resolve(configuredExecutablePath) }
      : {}),
  };
}

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
  transcriptSearchWorkers,
) {
  const entrypointUrl = (entry) => {
    const relativePath = toPosixPath(path.relative(repoRoot, entry.filePath));
    if (relativePath.startsWith('../')) {
      throw new Error(`Transcript search Worker is outside the compile root: ${entry.filePath}`);
    }
    return `new URL(${JSON.stringify(`./${relativePath}`)}, import.meta.url).href`;
  };
  const workerUrl = (name) => {
    const entry = transcriptSearchWorkers.entries.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`Missing transcript search ${name} Worker entrypoint.`);
    return entrypointUrl(entry);
  };
  const manifestExpression = `{
    mode: 'compiled',
    apiVersion: 1,
    workers: {
      indexer: ${workerUrl('indexer')},
      reader: ${workerUrl('reader')},
    }
  }`;
  return [
    `import '${assetsEntrypoint}';`,
    ...preMainModules.map((modulePath) => `import '${toPosixPath(modulePath)}';`),
    `const deepFreeze = (value) => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value)) deepFreeze(nested); } return value; };`,
    `Object.defineProperty(globalThis, Symbol.for('garcon.compiled-mode'), { value: true, writable: false, configurable: false });`,
    `Object.defineProperty(globalThis, Symbol.for('garcon.embedded-search-manifest.v1'), { value: deepFreeze(${manifestExpression}), writable: false, configurable: false });`,
    `await import('${serverMainPath}');`,
    '',
  ].join('\n');
}

async function bundleTranscriptSearchWorkers() {
  // Bun preserves paths relative to the compile root for Worker entrypoints.
  const directory = await fs.mkdtemp(
    path.join(repoRoot, 'node_modules', '.garcon-transcript-search-workers-'),
  );
  const entries = [];
  try {
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
      entries.push({ name, filePath });
    }
    return { directory, entries };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function buildExecutable(targetId, embeddedFiles, contributions, transcriptSearchWorkers) {
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
    entrypoints: [
      mainEntrypoint,
      ...transcriptSearchWorkers.entries.map((entry) => entry.filePath),
    ],
    compile: compileOptionsForTarget(targetId, outFile),
    naming: { asset: '[dir]/[name].[ext]' },
    files: {
      [assetsEntrypoint]: assetImports.join('\n'),
      [mainEntrypoint]: createVirtualMainEntrypoint(
        assetsEntrypoint,
        serverMainPath,
        contributions.flatMap((contribution) => contribution.preMainModules),
        transcriptSearchWorkers,
      ),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('Executable build failed.');
  }
  console.log(`Compiled ${target.outputName} with ${embeddedFiles.length} embedded assets.`);
}

async function buildCliExecutable(targetId) {
  const target = executableTargets[targetId];
  if (!target.cliOutputName) return;
  const outFile = path.resolve(executableDir, target.cliOutputName);
  const result = await Bun.build({
    entrypoints: [path.join(repoRoot, 'cli', 'main.ts')],
    compile: compileOptionsForTarget(targetId, outFile),
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('CLI executable build failed.');
  }
  console.log(`Compiled ${target.cliOutputName}.`);
}

async function run() {
  const targetIds = parseRequestedTargets(Bun.argv.slice(2));
  const embeddedFiles = await collectEmbeddedAssetInputs();
  const contributions = await collectAgentBuildContributions({ repoRoot });
  const transcriptSearchWorkers = await bundleTranscriptSearchWorkers();
  try {
    for (const targetId of targetIds) {
      await buildExecutable(targetId, embeddedFiles, contributions, transcriptSearchWorkers);
      await buildCliExecutable(targetId);
    }
  } finally {
    await fs.rm(transcriptSearchWorkers.directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
