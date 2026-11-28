import {
  buildCodexAppServerEndpointRuntime as originalBuildEndpoint,
  buildCodexHostProviderConfig as originalBuildHost,
} from '../../../../server-agents/codex/src/agents/codex/app-server/endpoint-runtime.ts';
import { resolveCodexModelCatalogPath } from '../../../../server-agents/codex/src/agents/codex/app-server/model-catalog.ts';

export { assertCodexSessionEndpoint } from '../../../../server-agents/codex/src/agents/codex/app-server/endpoint-runtime.ts';

function portableCatalog(config: NonNullable<ReturnType<typeof originalBuildHost>>) {
  return { ...config, modelCatalogPath: config.modelCatalogPath === resolveCodexModelCatalogPath() };
}

export function buildCodexAppServerEndpointRuntime(...args: Parameters<typeof originalBuildEndpoint>) {
  const result = originalBuildEndpoint(...args);
  return result && { codexConfig: portableCatalog(result.codexConfig) };
}

export function buildCodexHostProviderConfig(...args: Parameters<typeof originalBuildHost>) {
  const result = originalBuildHost(...args);
  return result && portableCatalog(result);
}
