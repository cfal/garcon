import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CodexProviderConfig } from '../runtime-types.js';

export const COMPILED_CODEX_MODEL_CATALOG_PATH = Symbol.for(
  'garcon.codex-model-catalog-path.v1',
);

// The catalog preserves Garcon's supported entries and overlays live model metadata
// captured from OpenAI's catalog through 2026-09-29.
export function resolveCodexModelCatalogPath(): string {
  const compiledPath = Reflect.get(globalThis, COMPILED_CODEX_MODEL_CATALOG_PATH);
  const catalogPath = typeof compiledPath === 'string'
    ? compiledPath
    : fileURLToPath(new URL('./codex-model-catalog.json', import.meta.url));
  if (!existsSync(catalogPath)) {
    throw new Error(`Garcon's bundled Codex model catalog is missing: ${catalogPath}`);
  }
  return catalogPath;
}

export function withCodexModelCatalog(
  providerConfig?: CodexProviderConfig,
): CodexProviderConfig {
  return {
    ...providerConfig,
    config: providerConfig?.config ?? {},
    modelCatalogPath: providerConfig?.modelCatalogPath ?? resolveCodexModelCatalogPath(),
  };
}
