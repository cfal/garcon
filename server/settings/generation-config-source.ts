import type { AgentCatalogEntry, AgentModelOption } from '../../common/agents.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('settings:generation-config-source');

export interface GenerationContext {
  authByAgent: Record<string, { authenticated?: boolean }>;
  readinessByAgent: Record<string, { ready?: boolean }>;
  modelsByAgent: Record<string, AgentModelOption[]>;
}

interface GenerationContextAgentSource {
  getAgentAuthStatusMap(): Promise<Record<string, unknown>>;
  getAgentReadinessMap(authByAgent?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getAgentCatalogEntries?(): Promise<AgentCatalogEntry[]>;
  getAgentCatalog?(): Promise<{ agents?: AgentCatalogEntry[] }>;
}

function emptyGenerationContext(): GenerationContext {
  return {
    authByAgent: {},
    readinessByAgent: {},
    modelsByAgent: {},
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function waitForPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function getAgentCatalogEntries(source: GenerationContextAgentSource): Promise<AgentCatalogEntry[]> {
  if (typeof source.getAgentCatalogEntries === 'function') {
    return source.getAgentCatalogEntries();
  }
  if (typeof source.getAgentCatalog === 'function') {
    const catalog = await source.getAgentCatalog();
    return Array.isArray(catalog?.agents) ? catalog.agents : [];
  }
  return [];
}

function modelsByAgentFromCatalog(entries: AgentCatalogEntry[]): Record<string, AgentModelOption[]> {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.id,
      Array.isArray(entry.models) ? entry.models : [],
    ]),
  );
}

function authByAgentFromRaw(raw: Record<string, unknown>): Record<string, { authenticated?: boolean }> {
  return Object.fromEntries(
    Object.entries(raw).map(([agentId, value]) => {
      const entry = asObject(value);
      return [agentId, { authenticated: entry.authenticated === true }];
    }),
  );
}

function readinessByAgentFromRaw(raw: Record<string, unknown>): Record<string, { ready?: boolean }> {
  return Object.fromEntries(
    Object.entries(raw).map(([agentId, value]) => {
      const entry = asObject(value);
      return [agentId, { ready: entry.ready === true }];
    }),
  );
}

export async function resolveGenerationContext(source: GenerationContextAgentSource): Promise<GenerationContext> {
  const catalogPromise = getAgentCatalogEntries(source);
  const [authResult, catalogResult] = await Promise.allSettled([
    source.getAgentAuthStatusMap(),
    catalogPromise,
  ]);
  const rawAuthByAgent = authResult.status === 'fulfilled' ? authResult.value : {};
  if (authResult.status === 'rejected') {
    logger.warn('generation auth discovery failed:', errorMessage(authResult.reason));
  }

  const [readinessResult] = await Promise.allSettled([
    source.getAgentReadinessMap(rawAuthByAgent),
  ]);
  const rawReadinessByAgent = readinessResult.status === 'fulfilled' ? readinessResult.value : {};
  if (readinessResult.status === 'rejected') {
    logger.warn('generation readiness discovery failed:', errorMessage(readinessResult.reason));
  }

  const catalogEntries = catalogResult.status === 'fulfilled' ? catalogResult.value : [];
  if (catalogResult.status === 'rejected') {
    logger.warn('generation model discovery failed:', errorMessage(catalogResult.reason));
  }

  return {
    authByAgent: authByAgentFromRaw(rawAuthByAgent),
    readinessByAgent: readinessByAgentFromRaw(rawReadinessByAgent),
    modelsByAgent: modelsByAgentFromCatalog(catalogEntries),
  };
}

export function hasExplicitGenerationSelection(persisted: unknown): boolean {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return false;
  const config = persisted as Record<string, unknown>;
  return typeof config.agentId === 'string'
    && config.agentId.trim().length > 0
    && typeof config.model === 'string'
    && config.model.trim().length > 0;
}

export async function resolveGenerationContextForSelection(
  source: GenerationContextAgentSource,
  persisted: unknown,
  signal?: AbortSignal,
): Promise<GenerationContext> {
  const [context] = await resolveGenerationContextsForSelections(source, [persisted], signal);
  return context;
}

export async function resolveGenerationContextsForSelections(
  source: GenerationContextAgentSource,
  persistedSelections: readonly unknown[],
  signal?: AbortSignal,
): Promise<GenerationContext[]> {
  if (signal?.aborted) throw abortReason(signal);

  const explicitSelections = persistedSelections.map(hasExplicitGenerationSelection);
  if (explicitSelections.every(Boolean)) {
    return explicitSelections.map(() => emptyGenerationContext());
  }

  const discovered = await waitForPromiseWithSignal(resolveGenerationContext(source), signal);
  return explicitSelections.map((isExplicit) => isExplicit ? emptyGenerationContext() : discovered);
}
