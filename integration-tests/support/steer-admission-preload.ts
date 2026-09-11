import { AgentRegistry } from '../../server/agents/registry.js';
import { AgentEventBus } from '../../server/agents/event-bus.js';

const gate = process.env.GARCON_TEST_STEER_ADMISSION_GATE;
if (!gate) throw new Error('Steering admission requires its isolated fixture barrier');

async function checkpoint(path: string): Promise<void> {
  const response = await fetch(`${gate}/${path}`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Synthetic admission checkpoint failed');
}

const admitInput = AgentRegistry.prototype.admitInput;
AgentRegistry.prototype.admitInput = async function(chatId, message, options) {
  if (options.commandType === 'steer') await checkpoint('admission');
  return admitInput.call(this, chatId, message, options);
};

const publishRunEnded = AgentEventBus.prototype.publishRunEnded;
AgentEventBus.prototype.publishRunEnded = async function(chatId, runId, row) {
  await checkpoint('terminal');
  return publishRunEnded.call(this, chatId, runId, row);
};
