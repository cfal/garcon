#!/usr/bin/env bun

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(repoRoot, 'web', 'build');
const executableDir = path.resolve(repoRoot, 'dist');

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

async function buildExecutable(targetId, embeddedFiles) {
  const virtualAssetsEntrypoint = '__garcon_embed_static_assets__.js';
  const virtualMainEntrypoint = '__garcon_build_exe_main__.js';
  const serverMainPath = toPosixPath(path.join(repoRoot, 'server', 'main.js'));
  const assetsImports = embeddedFiles.map((filePath) => {
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
        [virtualMainEntrypoint]: `import '${virtualAssetsEntrypoint}';\nimport '${serverMainPath}';`,
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

  console.log(`Compiled ${target.outputName} with ${embeddedFiles.length} embedded static assets.`);
}

async function run() {
  const targetIds = parseRequestedTargets(Bun.argv.slice(2));
  const embeddedFiles = await collectEmbeddedAssetInputs();
  for (const targetId of targetIds) {
    await buildExecutable(targetId, embeddedFiles);
  }
}

run().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
