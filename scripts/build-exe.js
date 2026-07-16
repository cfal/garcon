#!/usr/bin/env bun

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function createVirtualMainEntrypoint(virtualAssetsEntrypoint, serverMainPath) {
  return [
    `import '${virtualAssetsEntrypoint}';`,
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    '',
    "const PI_PACKAGE_JSON_SUFFIX = 'server/node_modules/@earendil-works/pi-coding-agent/package.json';",
    "const GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV = 'GARCON_EMBEDDED_PI_PACKAGE_DIR';",
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
    `await import('${serverMainPath}');`,
    '',
  ].join('\n');
}

async function buildExecutable(targetId, embeddedFiles) {
  const virtualAssetsEntrypoint = '__garcon_embed_static_assets__.js';
  const virtualMainEntrypoint = '__garcon_build_exe_main__.js';
  const serverMainPath = toPosixPath(path.join(repoRoot, 'server', 'main.js'));
  const transcriptSearchWorkerPath = toPosixPath(
    path.join(repoRoot, 'server', 'chats', 'search', 'worker.ts'),
  );
  const filesToEmbed = [...embeddedFiles, piPackageJsonPath];
  const assetsImports = filesToEmbed.map((filePath) => {
    return `import '${toPosixPath(filePath)}' with { type: 'file' };`;
  });
  const target = executableTargets[targetId];
  const outFile = path.resolve(executableDir, target.outputName);

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  let result;
  try {
    result = await Bun.build({
      entrypoints: [virtualMainEntrypoint, transcriptSearchWorkerPath],
      compile: {
        target: target.bunTarget,
        outfile: outFile,
      },
      naming: {
        asset: '[dir]/[name].[ext]',
      },
      files: {
        [virtualAssetsEntrypoint]: assetsImports.join('\n'),
        [virtualMainEntrypoint]: createVirtualMainEntrypoint(virtualAssetsEntrypoint, serverMainPath),
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
  for (const targetId of targetIds) {
    await buildExecutable(targetId, embeddedFiles);
  }
}

run().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
