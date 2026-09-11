import { AgentRegistry } from '../../server/agents/registry.js';

const gate = process.env.GARCON_TEST_EXECUTION_DISPATCH_GATE;
if (!gate) throw new Error('Execution dispatch requires its isolated fixture barrier');

const runAgentTurn = AgentRegistry.prototype.runAgentTurn;
AgentRegistry.prototype.runAgentTurn = async function(chatId, command, options = {}) {
  if (command === 'synthetic admitted input') {
    const response = await fetch(gate, {
      method: 'POST', body: JSON.stringify({ chatId, turnId: options.turnId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Synthetic dispatch checkpoint failed');
  }
  return runAgentTurn.call(this, chatId, command, options);
};
