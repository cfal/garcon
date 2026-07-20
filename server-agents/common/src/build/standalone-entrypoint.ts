import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GarconEmbeddedSearchManifestV1 {
  readonly mode: 'compiled';
  readonly apiVersion: 1;
  readonly workers: {
    readonly indexer: string;
    readonly reader: string;
  };
  readonly integrations: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const COMPILED_MODE = Symbol.for('garcon.compiled-mode');
const SEARCH_MANIFEST = Symbol.for('garcon.embedded-search-manifest.v1');

function globalValue(key: symbol): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[key];
}

function compiledManifest(): GarconEmbeddedSearchManifestV1 | null {
  if (globalValue(COMPILED_MODE) !== true) return null;
  const value = globalValue(SEARCH_MANIFEST);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Compiled transcript search manifest is missing');
  }
  const manifest = value as Partial<GarconEmbeddedSearchManifestV1>;
  if (manifest.mode !== 'compiled' || manifest.apiVersion !== 1) {
    throw new Error('Compiled transcript search manifest is invalid');
  }
  return manifest as GarconEmbeddedSearchManifestV1;
}

function requiredPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Compiled transcript search manifest is missing ${label}`);
  }
  const filePath = value.startsWith('file:') ? fileURLToPath(value) : value;
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Compiled transcript search manifest has invalid ${label}`);
  }
  return value;
}

export function resolveAgentStandaloneEntrypoint(input: {
  readonly integrationId: string;
  readonly name: string;
  readonly sourceUrl: URL;
}): string {
  const manifest = compiledManifest();
  if (!manifest) return input.sourceUrl.href;
  return requiredPath(
    manifest.integrations?.[input.integrationId]?.[input.name],
    `${input.integrationId}/${input.name}`,
  );
}

export function resolveSearchWorkerEntrypoints(input: {
  readonly indexerSourceUrl: URL;
  readonly readerSourceUrl: URL;
}): { readonly indexer: string; readonly reader: string } {
  const manifest = compiledManifest();
  if (!manifest) {
    return { indexer: input.indexerSourceUrl.href, reader: input.readerSourceUrl.href };
  }
  return {
    indexer: requiredPath(manifest.workers?.indexer, 'workers/indexer'),
    reader: requiredPath(manifest.workers?.reader, 'workers/reader'),
  };
}

export function isEmbeddedStandaloneEntrypoint(moduleUrl: string): boolean {
  // Bun exposes compiled JavaScript entrypoints to module loaders but not fs.access.
  return /(?:^|[/\\])\$bunfs(?:[/\\]|$)/.test(moduleUrl);
}
