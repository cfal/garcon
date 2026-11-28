import { UserMessage } from '../../../common/chat-types.ts';
import { preamblePrefixSha256 } from '../../../common/preamble-prefix.ts';
import { sanitizeRecordedPreamblePrefixes } from '../../../server/controller/ledger/preamble-history.ts';

export function sanitizePreambleFixture(
  rawMessages: readonly (readonly [string, boolean?])[],
  rawEvidence: readonly (readonly [string, boolean])[],
) {
  const messages = rawMessages.map(([content, literal]) => new UserMessage(
    'synthetic-time', content, undefined, literal ? { contentMode: 'literal' } : undefined,
  ));
  const evidence = rawEvidence.map(([prefix, requiresNativeOccurrence], index) => ({
    receipt: { format: 'preamble-v1' as const, codeUnitLength: prefix.length, sha256: preamblePrefixSha256(prefix) },
    boundary: { kind: 'new-chat' as const, ownershipEpoch: 'epoch-' + index },
    preambles: [{ id: '3502b645-222b-49d2-ac39-1c91f9fb1174', title: 'Synthetic rules' }],
    requiresNativeOccurrence,
  }));
  const result = sanitizeRecordedPreamblePrefixes({ messages, evidence });
  return result.kind === 'sanitized'
    ? { kind: result.kind, messages: result.messages.map(({ message, application }) => ({
        content: (message as UserMessage).content, ...(application ? { application } : {}),
      })) }
    : result;
}
