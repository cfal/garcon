import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every Worker that ships in a compiled executable. The build bundles each one separately
// and publishes its embedded location under the same name.
export const GARCON_WORKER_NAMES = ['search-indexer', 'search-reader', 'token-fitting', 'transcript-rendering'] as const;
export type GarconWorkerName = typeof GARCON_WORKER_NAMES[number];

export interface GarconEmbeddedWorkerManifestV1 {
  readonly mode: 'compiled';
  readonly apiVersion: 1;
  readonly workers: Readonly<Record<GarconWorkerName, string>>;
}

const COMPILED_MODE = Symbol.for('garcon.compiled-mode');
const WORKER_MANIFEST = Symbol.for('garcon.embedded-workers.v1');

function globalValue(key: symbol): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[key];
}

function compiledManifest(): GarconEmbeddedWorkerManifestV1 | null {
  if (globalValue(COMPILED_MODE) !== true) return null;
  const value = globalValue(WORKER_MANIFEST);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Compiled Worker manifest is missing');
  }
  const manifest = value as Partial<GarconEmbeddedWorkerManifestV1>;
  if (manifest.mode !== 'compiled' || manifest.apiVersion !== 1) {
    throw new Error('Compiled Worker manifest is invalid');
  }
  return manifest as GarconEmbeddedWorkerManifestV1;
}

// Resolves a Worker module: its source file when running from source, or its embedded
// bundle in a compiled executable.
export function resolveWorkerEntrypoint(name: GarconWorkerName, sourceUrl: URL): string {
  const manifest = compiledManifest();
  if (!manifest) return sourceUrl.href;
  const value: unknown = manifest.workers?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Compiled Worker manifest is missing workers/${name}`);
  }
  const filePath = value.startsWith('file:') ? fileURLToPath(value) : value;
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Compiled Worker manifest has invalid workers/${name}`);
  }
  return value;
}
