import { describe, expect, test } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../../../common/chat-types.js';
import { GARCON_ENVELOPE_COMMANDS } from '../../../../common/garcon-command-envelope.js';
import { garconCommandRejectionContent, garconCommandRejectionGuidance } from '../../../../common/garcon-command-rejection.js';
import { canonicalizeGarconProducerRows, dispatchGarconCommands } from '../garcon-command-publication.js';
import { importedDrafts, frozenDrafts } from '../imported-drafts.js';
import { ledgerRowsToTranscriptMessages } from '../presentation.js';

const AT = '2030-01-01T00:00:00.000Z';
const VIEW = '11111111-1111-4111-8111-111111111111';

describe('agent command parse feedback publication', () => {
  test.each(GARCON_ENVELOPE_COMMANDS)('publishes one rejection for malformed %s with committed correlation', (command) => {
    const content = `<garcon-${command} unknown="synthetic" />`;
    const result = canonicalizeGarconProducerRows([{ message: new AssistantMessage(AT, content) }]);
    expect(result.commands).toEqual([]);
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0].message.content).toBe(content);
    expect(result.drafts[1].message).toContain('Not executed.');
    expect(result.rejections).toEqual([{ noticeDraftIndex: 1,
      issues: [{ command, reason: 'malformed', edge: 'leading' }] }]);
    const calls = [];
    const unexpected = { request: () => { throw new Error('Malformed command dispatched'); } };
    dispatchGarconCommands(result, { chatId: '1000000000000001', viewId: VIEW, runId: null,
      chatIdRequests: unexpected, interAgentMessages: unexpected, agentStarts: unexpected,
      agentResumes: unexpected, agentStops: unexpected, agentSchedules: unexpected, ticketCommands: unexpected,
      committedRows: result.drafts.map((draft, index) => ({ ...draft, ordinal: 10 + index })),
      commandRejections: { reject: (...args) => calls.push(args) } });
    expect(calls).toEqual([[{ chatId: '1000000000000001', viewId: VIEW, noticeOrdinal: 11 }, result.rejections[0].issues]]);
  });

  test.each(['start-agent', 'resume-agent', 'stop-agent', 'send-message', 'schedule', 'ticket-create'])
  ('imports %s feedback only as diagnostic evidence without replayable work', async (command) => {
    const issues = [{ command, reason: 'malformed', edge: 'leading' }];
    const feedback = garconCommandRejectionContent({ sourceViewId: VIEW, sourceOrdinal: 2,
      issues, message: garconCommandRejectionGuidance(issues) });
    const drafts = await importedDrafts([{ message: new UserMessage(AT, feedback), providerMeta: null }], () => AT);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'notice', detail: { type: 'garcon-command-rejection-input' } });
    const rendered = ledgerRowsToTranscriptMessages(drafts.map((draft, index) => ({ ...draft, ordinal: index + 1 })));
    expect(rendered[0].message.content).toContain('Not executed.');
    expect(frozenDrafts(rendered.map((row) => row.message))).toEqual([]);
    expect(canonicalizeGarconProducerRows([{ message: new UserMessage(AT, feedback) }]).commands).toEqual([]);
  });
});
