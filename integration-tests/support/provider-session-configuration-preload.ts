import { LocalProviderConfigurationService } from '../../server/execution-node/local-provider-configuration.js';
import type { ProviderSessionConfigurationOperation, ProviderSessionConfigurationRequest,
  ProviderSessionConfigurationResult } from '../../server/execution-nodes/provider-configuration.js';
import { isRecord } from '../../common/json.js';

const applicationGate = process.env.GARCON_TEST_SESSION_CONFIGURATION_GATE ?? '';
if (!applicationGate) throw new Error('Session configuration requires its isolated fixture barrier');

interface PendingConfiguration {
  readonly request: ProviderSessionConfigurationRequest;
  readonly signal: AbortSignal;
}

const preparations = new WeakMap<LocalProviderConfigurationService,
  WeakMap<ProviderSessionConfigurationOperation, PendingConfiguration>>();

LocalProviderConfigurationService.prototype.prepareApply = async function (request, signal) {
  signal.throwIfAborted();
  let pending = preparations.get(this);
  if (!pending) {
    pending = new WeakMap();
    preparations.set(this, pending);
  }
  const operation = Object.freeze({}) as ProviderSessionConfigurationOperation;
  pending.set(operation, { request: structuredClone(request), signal });
  return { kind: 'prepared', operation };
};

LocalProviderConfigurationService.prototype.cancel = async function (operation) {
  preparations.get(this)?.delete(operation);
};

LocalProviderConfigurationService.prototype.commit = async function (operation, signal): Promise<ProviderSessionConfigurationResult> {
  const pending = preparations.get(this)?.get(operation);
  if (!pending) return { kind: 'rejected', reason: 'target-changed' };
  preparations.get(this)?.delete(operation);
  if (pending.signal.aborted || signal.aborted) return { kind: 'rejected', reason: 'cancelled' };
  const response = await fetch(applicationGate, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.request),
    signal: AbortSignal.any([pending.signal, signal, AbortSignal.timeout(30_000)]),
  });
  const result: unknown = await response.json();
  if (response.ok && isRecord(result)) {
    if (result.kind === 'applied' || result.kind === 'unknown' || result.kind === 'not-required') {
      return { kind: result.kind };
    }
    if (result.kind === 'rejected' && (result.reason === 'target-changed'
      || result.reason === 'target-conflict' || result.reason === 'cancelled')) {
      return { kind: 'rejected', reason: result.reason };
    }
  }
  throw new Error('Invalid synthetic session configuration outcome');
};
