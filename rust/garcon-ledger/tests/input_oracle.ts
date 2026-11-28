import { UserMessage } from '../../../common/chat-types.ts';
import type { PendingPreambleBoundary, Preamble } from '../../../common/preambles.ts';
import { encodeLedgerDraft } from '../../../server/controller/ledger/codec.ts';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.ts';
import { inputDetail } from '../../../server/controller/ledger/input-submission.ts';
import { preparePreambleInput } from '../../../server/controller/ledger/preamble-application.ts';

export function inputDetailFixture(at: string, content: string, clientMessageId: string | null, steer: boolean) {
  return JSON.parse(JSON.stringify(inputDetail({
    message: new UserMessage(at, content), clientMessageId, steer, attachments: [],
  })));
}

export function preparePreambleInputFixture(input: {
  at: string;
  clientMessageId: string | null;
  boundary: PendingPreambleBoundary | null;
  preambles: Pick<Preamble, 'id' | 'title' | 'content'>[];
}) {
  const preambles = input.preambles.map(preamble => ({
    ...preamble,
    enabled: true,
    scope: { type: 'global' as const },
    agentIds: [],
    tagFilter: { mode: 'any' as const, tags: [] },
    createdAt: input.at,
    updatedAt: input.at,
  }));
  const prepared = preparePreambleInput({
    chatId: 'synthetic-chat',
    viewId: transcriptViewId('synthetic-view'),
    at: input.at,
    detail: inputDetail({
      message: new UserMessage(input.at, 'Synthetic prompt'),
      clientMessageId: input.clientMessageId,
      steer: false,
      attachments: [],
    }),
    boundary: input.boundary,
    preambles,
  });
  return {
    detail: JSON.parse(JSON.stringify(prepared.detail)),
    drafts: prepared.drafts.map(encodeLedgerDraft),
    providerPrefix: prepared.providerPrefix,
  };
}
