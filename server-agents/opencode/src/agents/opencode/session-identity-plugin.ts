import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMPILED_SESSION_IDENTITY_PLUGIN_PATH = Symbol.for(
  'garcon.opencode-session-identity-plugin-path.v1',
);

export function resolveSessionIdentityPluginUrl(): string {
  const compiledPath = Reflect.get(globalThis, COMPILED_SESSION_IDENTITY_PLUGIN_PATH);
  const pluginPath = typeof compiledPath === 'string'
    ? compiledPath
    : fileURLToPath(new URL('./garcon-session-identity.mjs', import.meta.url));
  if (!existsSync(pluginPath)) {
    throw new Error(`Garcon's bundled OpenCode session identity plugin is missing: ${pluginPath}`);
  }
  return pathToFileURL(pluginPath).href;
}
