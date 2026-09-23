import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CodexProviderConfig } from '../runtime-types.js';

export const COMPILED_CODEX_MODEL_CATALOG_PATH = Symbol.for(
  'garcon.codex-model-catalog-path.v1',
);

// The catalog preserves Codex 0.156.0's bundled entries and adds the live Sol/Luna entries
// captured from OpenAI's model service on 2026-09-22.
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
