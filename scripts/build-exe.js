#!/usr/bin/env bun

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSCRIPT_SEARCH_WORKER_PATH_ENV } from '../server/chats/search/worker-runtime.ts';
import { collectAgentBuildContributions } from './agent-build-metadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(repoRoot, 'web', 'build');
const executableDir = path.resolve(repoRoot, 'dist');
const piPackageJsonPath = path.resolve(
  repoRoot,
  'server',
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'package.json',
);

const executableTargets = {
  'linux-x64': {
    bunTarget: 'bun-linux-x64-baseline',
    outputName: 'garcon-linux-x64',
  },
  'darwin-arm64': {
    bunTarget: 'bun-darwin-arm64',
    outputName: 'garcon-darwin-arm64',
  },
  'windows-x64': {
    bunTarget: 'bun-windows-x64-baseline',
    outputName: 'garcon-windows-x64.exe',
  },
};

async function listFilesRecursive(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath));
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function parseRequestedTargets(argv) {
  const targetArgs = argv.filter((argument) => argument.startsWith('--target='));
  if (targetArgs.length === 0) return Object.keys(executableTargets);

  const requestedTargets = targetArgs.flatMap((argument) => {
    return argument.slice('--target='.length).split(',').map((value) => value.trim()).filter(Boolean);
  });

  const invalidTarget = requestedTargets.find((target) => !executableTargets[target]);
  if (invalidTarget) {
    const supportedTargets = Object.keys(executableTargets).join(', ');
    throw new Error(`Unsupported executable target "${invalidTarget}". Supported targets: ${supportedTargets}.`);
  }

  return [...new Set(requestedTargets)];
}

async function collectEmbeddedAssetInputs() {
  const distStat = await fs.stat(distDir).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(`Missing web build output directory: ${distDir}. Run "bun run build" first.`);
  }

  const files = (await listFilesRecursive(distDir)).sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    throw new Error(`web/build is empty: ${distDir}`);
  }

  return files;
}

async function assertPiPackageMetadataExists() {
  const stat = await fs.stat(piPackageJsonPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Missing Pi package metadata: ${piPackageJsonPath}. Run "bun install --cwd server" first.`);
  }
}

/**
 * Generates a bootstrap entrypoint instead of a static server import.
 * Pi's SDK reads package metadata at module evaluation in Bun compiled-binary mode.
 */
function createVirtualMainEntrypoint(
  virtualAssetsEntrypoint,
  serverMainPath,
  transcriptSearchWorkerAssetPath,
  preMainModules,
) {
  return [
    `import '${virtualAssetsEntrypoint}';`,
    ...preMainModules.map((modulePath) => `import '${toPosixPath(modulePath)}';`),
    `import transcriptSearchWorkerPath from '${transcriptSearchWorkerAssetPath}' with { type: 'file' };`,
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    '',
    "const PI_PACKAGE_JSON_SUFFIX = 'node_modules/@earendil-works/pi-coding-agent/package.json';",
    "const GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV = 'GARCON_EMBEDDED_PI_PACKAGE_DIR';",
    `const TRANSCRIPT_SEARCH_WORKER_PATH_ENV = '${TRANSCRIPT_SEARCH_WORKER_PATH_ENV}';`,
    '',
    'function normalizeEmbeddedFileName(name) {',
    "  return name.replaceAll('\\\\', '/');",
    '}',
    '',
    'async function prepareEmbeddedPiPackageDir() {',
    '  if (process.env.PI_PACKAGE_DIR) return;',
    '  const packageJsonBlob = Bun.embeddedFiles.find((blob) => {',
    "    return blob instanceof Blob && normalizeEmbeddedFileName(blob.name).endsWith(PI_PACKAGE_JSON_SUFFIX);",
    '  });',
    '  if (!(packageJsonBlob instanceof Blob)) {',
    "    throw new Error('Garcon executable is missing embedded Pi package metadata.');",
    '  }',
    '',
    "  // Presents Pi's package metadata before SDK imports run in Bun compiled-binary mode.",
    "  const packageDir = join(tmpdir(), 'garcon-pi-coding-agent', String(process.pid));",
    '  await mkdir(packageDir, { recursive: true });',
    "  await writeFile(join(packageDir, 'package.json'), await packageJsonBlob.text());",
    '  process.env.PI_PACKAGE_DIR = packageDir;',
    '  process.env[GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV] = packageDir;',
    '}',
    '',
    'await prepareEmbeddedPiPackageDir();',
    'process.env[TRANSCRIPT_SEARCH_WORKER_PATH_ENV] = transcriptSearchWorkerPath;',
    `await import('${serverMainPath}');`,
    '',
  ].join('\n');
}

async function bundleAgentStandaloneEntrypoints(contributions) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-agent-entrypoints-'));
  const files = [];
  try {
    for (const contribution of contributions) {
      for (const [index, entrypoint] of contribution.standaloneEntrypoints.entries()) {
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
          `${contribution.integrationId}-${index}-${path.basename(entrypoint, path.extname(entrypoint))}.js`,
        );
        await fs.writeFile(filePath, await result.outputs[0].arrayBuffer());
        files.push(filePath);
      }
    }
    return { directory, files };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function bundleTranscriptSearchWorker() {
  const workerSourcePath = path.join(repoRoot, 'server', 'chats', 'search', 'worker.ts');
  const providerWorkerSources = [
    'claude',
    'codex',
    'cursor',
    'direct',
    'factory',
    'opencode',
    'pi',
  ].map((provider) => `server/agents/${provider}/search-transcript-source.ts`);
  const result = await Bun.build({
    entrypoints: [workerSourcePath],
    target: 'bun',
    format: 'esm',
    minify: true,
    metafile: true,
  });
  if (!result.success || result.outputs.length !== 1) {
    for (const log of result.logs) console.error(log);
    throw new Error('Transcript search worker bundle failed.');
  }
  const bundledInputs = Object.keys(result.metafile?.inputs ?? {})
    .map((input) => input.replaceAll('\\', '/'));
  const missingProviderSources = providerWorkerSources.filter((source) =>
    !bundledInputs.some((input) => input.endsWith(source)));
  if (missingProviderSources.length > 0) {
    throw new Error(`Transcript search worker omitted provider sources: ${missingProviderSources.join(', ')}`);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-transcript-search-worker-'));
  const filePath = path.join(directory, 'worker.js');
  await fs.writeFile(filePath, await result.outputs[0].arrayBuffer());
  return { directory, filePath };
}

async function buildExecutable(
  targetId,
  embeddedFiles,
  transcriptSearchWorkerAssetPath,
  contributions,
) {
  const virtualAssetsEntrypoint = '__garcon_embed_static_assets__.js';
  const virtualMainEntrypoint = '__garcon_build_exe_main__.js';
  const serverMainPath = toPosixPath(path.join(repoRoot, 'server', 'main.js'));
  const filesToEmbed = [
    ...embeddedFiles,
    piPackageJsonPath,
    ...contributions.flatMap((contribution) => contribution.embeddedDependencyMetadata),
  ];
  const assetsImports = filesToEmbed.map((filePath) => {
    return `import '${toPosixPath(filePath)}' with { type: 'file' };`;
  });
  const target = executableTargets[targetId];
  const outFile = path.resolve(executableDir, target.outputName);

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  let result;
  try {
    result = await Bun.build({
      entrypoints: [virtualMainEntrypoint],
      compile: {
        target: target.bunTarget,
        outfile: outFile,
      },
      naming: {
        asset: '[dir]/[name].[ext]',
      },
      files: {
        [virtualAssetsEntrypoint]: assetsImports.join('\n'),
        [virtualMainEntrypoint]: createVirtualMainEntrypoint(
          virtualAssetsEntrypoint,
          serverMainPath,
          toPosixPath(transcriptSearchWorkerAssetPath),
          contributions.flatMap((contribution) => contribution.preMainModules),
        ),
      },
    });
  } catch (error) {
    console.error(error);
    throw error;
  }

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('Executable build failed.');
  }

  console.log(`Compiled ${target.outputName} with ${embeddedFiles.length} embedded static assets and Pi metadata.`);
}

async function run() {
  const targetIds = parseRequestedTargets(Bun.argv.slice(2));
  await assertPiPackageMetadataExists();
  const embeddedFiles = await collectEmbeddedAssetInputs();
  const contributions = await collectAgentBuildContributions({ repoRoot });
  const workerAsset = await bundleTranscriptSearchWorker();
  const agentAssets = await bundleAgentStandaloneEntrypoints(contributions);
  try {
    const allEmbeddedFiles = [...embeddedFiles, ...agentAssets.files];
    for (const targetId of targetIds) {
      await buildExecutable(
        targetId,
        allEmbeddedFiles,
        workerAsset.filePath,
        contributions,
      );
    }
  } finally {
    await fs.rm(workerAsset.directory, { recursive: true, force: true });
    await fs.rm(agentAssets.directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
