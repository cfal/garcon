import { AgentRegistry } from '../../server/agents/registry.js';
import { ChatExecutionControlOperations } from '../../server/chat-execution/chat-execution-control-operations.js';

const gate = process.env.GARCON_TEST_EXECUTION_ADMISSION_GATE;
if (!gate) throw new Error('Execution admission requires its isolated fixture barrier');

const pending = new Map<string, string>();
let preparations = 0;
const prepareTurn = AgentRegistry.prototype.prepareTurn;
AgentRegistry.prototype.prepareTurn = async function (chatId, options, signal) {
  const prepared = await prepareTurn.call(this, chatId, options, signal);
  if (++preparations === 2) pending.set(chatId, options.turnId ?? 'synthetic-turn');
  return prepared;
};

async function admit<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
  const turnId = pending.get(chatId);
  if (!turnId) return operation();
  pending.delete(chatId);
  const response = await fetch(`${gate}/enter`, {
    method: 'POST', body: JSON.stringify({ turnId }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Synthetic admission barrier failed');
  try { return await operation(); }
  finally {
    await fetch(`${gate}/settled`, { method: 'POST', signal: AbortSignal.timeout(5_000) });
  }
}

const dequeueNextTurn = ChatExecutionControlOperations.prototype.dequeueNextTurn;
ChatExecutionControlOperations.prototype.dequeueNextTurn = function (...args) {
  return admit(args[0], () => dequeueNextTurn.apply(this, args));
};
