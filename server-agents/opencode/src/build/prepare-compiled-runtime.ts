import '../agents/opencode/garcon-session-identity.mjs' with { type: 'file' };
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPILED_SESSION_IDENTITY_PLUGIN_PATH } from '../agents/opencode/session-identity-plugin.js';

const PLUGIN_FILE_NAME = 'garcon-session-identity.mjs';

function embeddedFileName(file: Blob): string | null {
  return 'name' in file && typeof file.name === 'string'
    ? file.name.replaceAll('\\', '/')
    : null;
}

async function prepareCompiledSessionIdentityPlugin(): Promise<void> {
  const plugin = Bun.embeddedFiles.find((file) => (
    embeddedFileName(file)?.endsWith(`/${PLUGIN_FILE_NAME}`)
  ));
  if (!(plugin instanceof Blob)) {
    throw new Error('Garcon executable is missing the bundled OpenCode session identity plugin.');
  }

  const directory = await mkdtemp(join(tmpdir(), 'garcon-opencode-session-identity-'));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  process.once('exit', cleanup);
  const pluginPath = join(directory, PLUGIN_FILE_NAME);
  try {
    await writeFile(pluginPath, new Uint8Array(await plugin.arrayBuffer()), {
      flag: 'wx',
      mode: 0o600,
    });
    Object.defineProperty(globalThis, COMPILED_SESSION_IDENTITY_PLUGIN_PATH, {
      value: pluginPath,
      writable: false,
      configurable: false,
    });
  } catch (error) {
    process.off('exit', cleanup);
    cleanup();
    throw error;
  }
}

await prepareCompiledSessionIdentityPlugin();
