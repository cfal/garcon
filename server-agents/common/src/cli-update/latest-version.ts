import { runBoundedCommand } from './bounded-command.js';
import { isCliVersion } from './cli-version.js';

export type LatestVersionLookup = (signal: AbortSignal) => Promise<string | null>;

const FOUND_TTL_MS = 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 1000;
const LOOKUP_TIMEOUT_MS = 4_000;
const TOOL_LOOKUP_TIMEOUT_MS = 10_000;
const TOOL_LOOKUP_MAX_BYTES = 256 * 1024;
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';

interface CacheEntry {
  readonly value: Promise<string | null>;
  expiresAt: number;
}

// Caches found versions for an hour and misses for a minute, sharing one
// in-flight lookup per key. A lookup that throws is not cached.
export class LatestVersionCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get(key: string, lookup: LatestVersionLookup, options: { readonly fresh: boolean; readonly signal: AbortSignal }): Promise<string | null> {
    const existing = this.#entries.get(key);
    if (existing && !options.fresh && existing.expiresAt > this.#now()) return existing.value;
    const entry: CacheEntry = { value: lookup(options.signal), expiresAt: Number.POSITIVE_INFINITY };
    this.#entries.set(key, entry);
    entry.value.then(
      (version) => { entry.expiresAt = this.#now() + (version === null ? MISSING_TTL_MS : FOUND_TTL_MS); },
      () => { if (this.#entries.get(key) === entry) this.#entries.delete(key); },
    );
    return entry.value;
  }

  clear(): void {
    this.#entries.clear();
  }
}

// Asks npm itself so its registry, scoped auth, and proxy configuration apply;
// reads the public registry only when npm is not installed.
export function npmLatestVersion(packageName: string, env: Record<string, string>): LatestVersionLookup {
  return async (signal) => {
    const npm = Bun.which('npm', { PATH: env.PATH ?? '' });
    if (!npm) return fetchNpmRegistryVersion(packageName, signal);
    const result = await runBoundedCommand([npm, 'view', '--global', '--json', `${packageName}@latest`, 'version'], {
      env, signal, timeoutMs: TOOL_LOOKUP_TIMEOUT_MS, maxOutputBytes: TOOL_LOOKUP_MAX_BYTES,
    });
    if (result.exitCode !== 0 || result.truncated) return null;
    return parseNpmViewVersion(result.stdout);
  };
}

export function parseNpmViewVersion(output: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const version = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  return typeof version === 'string' && isCliVersion(version) ? version : null;
}

async function fetchNpmRegistryVersion(packageName: string, signal: AbortSignal): Promise<string | null> {
  const body = await fetchWithTimeout(`${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}/latest`, signal, 'application/json');
  if (body === null) return null;
  try {
    const version: unknown = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === 'string' && isCliVersion(version) ? version : null;
  } catch {
    return null;
  }
}

export function homebrewLatestVersion(
  source: { readonly brew: string; readonly name: string; readonly cask: boolean },
  env: Record<string, string>,
): LatestVersionLookup {
  return async (signal) => {
    const result = await runBoundedCommand([source.brew, 'info', '--json=v2', ...(source.cask ? ['--cask'] : []), source.name], {
      env, signal, timeoutMs: TOOL_LOOKUP_TIMEOUT_MS, maxOutputBytes: TOOL_LOOKUP_MAX_BYTES,
    });
    if (result.exitCode !== 0 || result.truncated) return null;
    return parseHomebrewInfoVersion(result.stdout, source.cask);
  };
}

export function parseHomebrewInfoVersion(output: string, cask: boolean): string | null {
  try {
    const info = JSON.parse(output) as {
      formulae?: { versions?: { stable?: unknown } }[];
      casks?: { version?: unknown }[];
    };
    const raw = cask ? info.casks?.[0]?.version : info.formulae?.[0]?.versions?.stable;
    // Cask versions may carry a build suffix after a comma.
    const version = typeof raw === 'string' ? raw.split(',')[0]! : null;
    return version && isCliVersion(version) ? version : null;
  } catch {
    return null;
  }
}

// Reads a release channel whose body yields a version through `parse`.
export function channelLatestVersion(url: string, parse: (body: string) => string | null): LatestVersionLookup {
  return async (signal) => {
    const body = await fetchWithTimeout(url, signal);
    if (body === null) return null;
    const version = parse(body);
    return version && isCliVersion(version) ? version : null;
  };
}

// The deadline covers the body too; headers can arrive before the body stalls.
async function fetchWithTimeout(url: string, signal: AbortSignal, accept?: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
      ...(accept ? { headers: { accept } } : {}),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    signal.throwIfAborted();
    return null;
  }
}
