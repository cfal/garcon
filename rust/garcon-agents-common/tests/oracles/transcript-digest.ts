import { parseChatMessages } from '../../../../common/chat-types.ts';
import { OrderedTranscriptDigest } from '../../../../server-agents/common/src/forking/transcript-digest.ts';

export function orderedTranscriptDigest(input: unknown): string {
  const digest = new OrderedTranscriptDigest();
  for (const row of parseChatMessages(input)) digest.add(row);
  return digest.digest();
}
