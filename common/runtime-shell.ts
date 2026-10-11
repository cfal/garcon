import { parseBasePath } from './base-path.js';

export const RUNTIME_BASE_PATH_TOKEN = '__GARCON_RUNTIME_BASE_PATH__';

export function renderRuntimeShell(template: string, basePath: string): string {
  if (!template.includes(RUNTIME_BASE_PATH_TOKEN)) {
    throw new Error('Web shell is not runtime-mountable; run bun run build');
  }
  return template.replaceAll(RUNTIME_BASE_PATH_TOKEN, parseBasePath(basePath));
}
