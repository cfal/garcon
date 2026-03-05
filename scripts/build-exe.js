#!/usr/bin/env bun

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(repoRoot, 'web', 'build');
const buildTarget = process.env.BUN_BUILD_TARGET?.trim() || null;
const outName = process.env.BUN_BUILD_OUTPUT_NAME?.trim()
  || (buildTarget ? `garcon-${buildTarget}${buildTarget.includes('windows') ? '.exe' : ''}` : 'garcon');
const outFile = path.resolve(repoRoot, 'dist', outName);

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

async function buildExecutable() {
  const distStat = await fs.stat(distDir).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(`Missing web build output directory: ${distDir}. Run "bun run build" first.`);
  }

  const files = (await listFilesRecursive(distDir)).sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    throw new Error(`web/build is empty: ${distDir}`);
  }

  const virtualAssetsEntrypoint = '__garcon_embed_static_assets__.js';
  const virtualMainEntrypoint = '__garcon_build_exe_main__.js';
  const serverMainPath = toPosixPath(path.join(repoRoot, 'server', 'main.js'));
  const assetsImports = files.map((filePath) => {
    return `import '${toPosixPath(filePath)}' with { type: 'file' };`;
  });

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const compile = { outfile: outFile };
  if (buildTarget) compile.target = buildTarget;
  let result;
  try {
    result = await Bun.build({
      entrypoints: [virtualMainEntrypoint],
      compile,
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

  const targetLabel = buildTarget ? ` for ${buildTarget}` : '';
  console.log(`Compiled executable at dist/${outName}${targetLabel} with ${files.length} embedded static assets.`);
}

buildExecutable().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
