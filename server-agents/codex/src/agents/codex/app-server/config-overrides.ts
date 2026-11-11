import type { CodexConfigObject, CodexConfigValue } from '../runtime-types.js';

export function appendCodexConfigArgs(args: string[], config?: CodexConfigObject): void {
  if (!config) return;
  const overrides: string[] = [];
  flattenCodexConfigOverrides(config, '', overrides);
  for (const override of overrides) args.push('--config', override);
}

function flattenCodexConfigOverrides(value: CodexConfigValue, prefix: string, overrides: string[]): void {
  // Codex splits override paths on literal dots, including quoted path segments.
  if (prefix === 'model_providers' || !isPlainCodexConfigObject(value)) {
    if (!prefix) throw new Error('Codex config overrides must be a plain object');
    overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
    return;
  }

  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) return;
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }

  for (const [key, child] of entries) {
    if (!key) throw new Error('Codex config override keys must be non-empty strings');
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainCodexConfigObject(child)) {
      flattenCodexConfigOverrides(child, childPath, overrides);
    } else {
      overrides.push(`${childPath}=${toTomlValue(child, childPath)}`);
    }
  }
}

function toTomlValue(value: CodexConfigValue, pathName: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${pathName} must be a finite number`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => toTomlValue(item, `${pathName}[${index}]`)).join(', ')}]`;
  }
  if (isPlainCodexConfigObject(value)) {
    return `{${Object.entries(value)
      .map(([key, child]) => `${formatTomlKey(key)} = ${toTomlValue(child, `${pathName}.${key}`)}`)
      .join(', ')}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${pathName}: ${typeof value}`);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function isPlainCodexConfigObject(value: unknown): value is CodexConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
