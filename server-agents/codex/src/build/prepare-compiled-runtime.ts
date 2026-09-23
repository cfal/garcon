import '../agents/codex/app-server/codex-model-catalog.json' with { type: 'file' };
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPILED_CODEX_MODEL_CATALOG_PATH } from '../agents/codex/app-server/model-catalog.js';

const CATALOG_FILE_NAME = 'codex-model-catalog.json';

function embeddedFileName(file: Blob): string | null {
  return 'name' in file && typeof file.name === 'string'
    ? file.name.replaceAll('\\', '/')
    : null;
}

async function prepareCompiledCodexModelCatalog(): Promise<void> {
  const catalog = Bun.embeddedFiles.find((file) => (
    embeddedFileName(file)?.endsWith(`/${CATALOG_FILE_NAME}`)
  ));
  if (!(catalog instanceof Blob)) {
    throw new Error('Garcon executable is missing the bundled Codex model catalog.');
  }

  const directory = await mkdtemp(join(tmpdir(), 'garcon-codex-model-catalog-'));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  process.once('exit', cleanup);
  const catalogPath = join(directory, CATALOG_FILE_NAME);
  try {
    await writeFile(catalogPath, new Uint8Array(await catalog.arrayBuffer()), {
      flag: 'wx',
      mode: 0o600,
    });
    Object.defineProperty(globalThis, COMPILED_CODEX_MODEL_CATALOG_PATH, {
      value: catalogPath,
      writable: false,
      configurable: false,
    });
  } catch (error) {
    process.off('exit', cleanup);
    cleanup();
    throw error;
  }
}

await prepareCompiledCodexModelCatalog();
