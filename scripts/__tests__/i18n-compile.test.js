import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));

test('compiles every message without network access or a plugin cache', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-i18n-offline-'));
  try {
    await fs.mkdir(path.join(directory, 'project.inlang'));
    await fs.mkdir(path.join(directory, 'messages'));
    await Promise.all([
      fs.copyFile(path.join(webRoot, 'package.json'), path.join(directory, 'package.json')),
      fs.copyFile(path.join(webRoot, 'project.inlang/settings.json'), path.join(directory, 'project.inlang/settings.json')),
      fs.copyFile(path.join(webRoot, 'messages/en.json'), path.join(directory, 'messages/en.json')),
      fs.symlink(path.join(webRoot, 'node_modules'), path.join(directory, 'node_modules'), 'junction'),
    ]);
    const denyNetworkPath = path.join(directory, 'deny-network.mjs');
    await fs.writeFile(denyNetworkPath, `
      globalThis.fetch = async () => { throw new Error('Network disabled by i18n regression test'); };
      process.stdout.write('i18n regression: network disabled\\n');
    `);
    const compiled = spawnSync('bun', ['run', 'i18n:compile'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(denyNetworkPath).href}`,
      },
    });
    expect(compiled.error).toBeUndefined();
    expect(compiled.status).toBe(0);
    expect(compiled.stdout).toContain('i18n regression: network disabled');
    expect(compiled.stdout + compiled.stderr).not.toContain('PluginImportError');

    const translations = JSON.parse(await fs.readFile(path.join(directory, 'messages/en.json'), 'utf8'));
    const messages = await import(pathToFileURL(path.join(directory, 'src/lib/paraglide/messages.js')).href);
    // A plugin that failed to load compiles nothing, so every key must be present.
    const missing = Object.keys(translations).filter((key) => !key.startsWith('$') && typeof messages[key] !== 'function');
    expect(missing).toEqual([]);
    expect(messages.common_close({}, { locale: 'en' })).toBe(translations.common_close);
    await expect(fs.stat(path.join(directory, 'src/lib/paraglide/messages/en.js'))).resolves.toBeDefined();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 65000);
