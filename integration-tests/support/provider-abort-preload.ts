import { DirectExecution } from '../../server-agents/common/src/direct/execution.js';

const gate = process.env.GARCON_TEST_PROVIDER_ABORT_GATE;
if (!gate) throw new Error('Provider abort fixture requires its isolated barrier');

const abort = DirectExecution.prototype.abort;
DirectExecution.prototype.abort = async function (agentSessionId, publish) {
  const admitted = await fetch(`${gate}/hold`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  if (!admitted.ok) throw new Error('Provider abort barrier failed');
  const result = await abort.call(this, agentSessionId, publish);
  const recorded = await fetch(`${gate}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
    signal: AbortSignal.timeout(5_000),
  });
  if (!recorded.ok) throw new Error('Provider abort result barrier failed');
  return result;
};
