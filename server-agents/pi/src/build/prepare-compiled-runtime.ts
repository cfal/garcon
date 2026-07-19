import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PI_PACKAGE_JSON_SUFFIX = '/@earendil-works/pi-coding-agent/package.json';
const GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV = 'GARCON_EMBEDDED_PI_PACKAGE_DIR';

function normalizeEmbeddedFileName(name: string): string {
  return name.replaceAll('\\', '/');
}

function embeddedFileName(file: Blob): string | null {
  return 'name' in file && typeof file.name === 'string' ? file.name : null;
}

async function prepareEmbeddedPiPackageDirectory(): Promise<void> {
  if (process.env.PI_PACKAGE_DIR) return;

  const packageJson = Bun.embeddedFiles.find((file) => (
    normalizeEmbeddedFileName(embeddedFileName(file) ?? '').endsWith(PI_PACKAGE_JSON_SUFFIX)
  ));
  if (!(packageJson instanceof Blob)) {
    throw new Error('Garcon executable is missing embedded Pi package metadata.');
  }

  // Presents Pi package metadata before the lazy SDK is imported by the compiled executable.
  const packageDirectory = join(tmpdir(), 'garcon-pi-coding-agent', String(process.pid));
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), await packageJson.text());
  process.env.PI_PACKAGE_DIR = packageDirectory;
  process.env[GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV] = packageDirectory;
}

await prepareEmbeddedPiPackageDirectory();
