import { LocalProviderConfigurationService } from '../../server/execution-node/local-provider-configuration.js';
import type { ProviderSessionConfigurationResult } from '../../server/execution-nodes/provider-configuration.js';
import { isRecord } from '../../common/json.js';

const applicationGate = process.env.GARCON_TEST_SESSION_CONFIGURATION_GATE ?? '';
if (!applicationGate) throw new Error('Session configuration requires its isolated fixture barrier');

LocalProviderConfigurationService.prototype.apply = async function (request, signal): Promise<ProviderSessionConfigurationResult> {
  const response = await fetch(applicationGate, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const result: unknown = await response.json();
  if (!response.ok || !isRecord(result) || (result.kind !== 'applied' && result.kind !== 'unknown')) {
    throw new Error('Invalid synthetic session configuration outcome');
  }
  return { kind: result.kind };
};
