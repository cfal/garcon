import { CarryOverCompactionService } from '../../../../server/controller/chats/carryover/compaction.ts';
import { resolveCarryOverOutcome } from '../../../../server/controller/chats/carryover/outcome.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const cases = [
  { name: 'no-history', replies: [] },
  { name: 'disabled', replies: [] },
  { name: 'unsafe', replies: [] },
  { name: 'retry', replies: ['unframed summary', '\ufeff<summary>Objective & next step\nKeep spacing</summary>\u00a0'] },
  { name: 'failed', replies: ['<summary>\u00a0</summary>', '<summary>first <summary\u00a0nested></summary>'] },
  { name: 'reduced-does-not-fit', replies: ['bad prompt output'] },
] as const;
const results = [];
for (const { name, replies } of cases) {
  const pending = [...replies];
  const calls: unknown[] = [];
  const service = new CarryOverCompactionService({
    agents: {
      async getAgentAuthStatusMap() { throw new Error('explicit selection must not discover'); },
      async getAgentCatalogEntries() { throw new Error('explicit selection must not discover'); },
      async getAgentReadinessMap() { throw new Error('explicit selection must not discover'); },
      singleQueryRunsToolsWithoutPermission(agentId, executorId) {
        calls.push(['gate', agentId, executorId]);
        return name === 'unsafe';
      },
      async runSingleQuery(prompt, options) {
        calls.push(['query', prompt, options.timeoutMs]);
        if (!pending.length) throw new Error('unexpected extra query');
        return pending.shift()!;
      },
    },
    fitting: {
      async assessCarryover() {
        calls.push(['assess']);
        return { kind: name === 'no-history' ? 'no-history' : 'needs-compaction' };
      },
      async fitCompactionPrompt(input) {
        calls.push(['fit', input.contextWindowTokens, input.maximumEntryBudgetTokens]);
        return input.maximumEntryBudgetTokens !== null && name === 'reduced-does-not-fit'
          ? { kind: 'unavailable', reason: 'prompt-exceeds-window' }
          : {
            kind: 'fitted', prompt: input.maximumEntryBudgetTokens === null ? 'first' : 'reduced',
            entryBudgetTokens: input.maximumEntryBudgetTokens ?? 101,
          };
      },
      async projectCompactedCarryover(_messages, summary) {
        calls.push(['project', summary]);
        return { prefix: `carry ${summary}` };
      },
    },
    getUiSettings() {
      calls.push(['settings']);
      return { agentSwitchCompaction: {
        enabled: name !== 'disabled', contextWindowTokens: 200_000, agentId: 'claude', model: 'haiku',
      } };
    },
    onCompactionStarted: () => { calls.push(['unexpected-global-progress']); },
  });
  try {
    const outcome = await service.planFor({
      onCompactionStarted: () => { calls.push(['started']); },
      operation: name === 'disabled' ? 'fresh-start' : 'agent-switch',
      chatId: 'synthetic', messages: [], destination: { agentId: 'codex', model: 'next', prompt: 'continue' },
    });
    results.push({ name, result: { outcome, resolved: resolveCarryOverOutcome(outcome) }, calls });
  } catch (error) {
    results.push({ name, result: { code: error.code, message: error.message, status: error.status, retryable: error.retryable }, calls });
  }
}
process.stdout.write(JSON.stringify(results));
