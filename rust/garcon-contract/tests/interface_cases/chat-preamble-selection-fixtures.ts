import { parsePreambleSelectionPreviewRequest } from '../../../../common/chat-preamble-selection-contracts.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const base = { executorId: '22222222-2222-4222-8222-222222222222', agentId: 'codex', tags: ['service'], projectPath: '/synthetic' };
for (const input of [base, { ...base, orderedPreambleIds: [] }]) {
  console.log(JSON.stringify({ input, expected: JSON.stringify(parsePreambleSelectionPreviewRequest(input)) }));
}
