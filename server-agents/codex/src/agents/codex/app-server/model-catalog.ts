import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CodexProviderConfig } from '../runtime-types.js';

export const COMPILED_CODEX_MODEL_CATALOG_PATH = Symbol.for(
  'garcon.codex-model-catalog-path.v1',
);

// The catalog preserves Garcon's supported entries and overlays live model metadata
// captured from OpenAI's catalog through 2026-09-29, plus the published Terra entry:
// https://github.com/openai/codex/blob/126a0ee92ed2c5e73cd8a8f7e37563e8527552d7/codex-rs/models-manager/models.json#L352-L527
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
