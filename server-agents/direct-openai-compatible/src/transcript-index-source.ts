import { DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID } from '@garcon/common/agents';
import { createJournalTranscriptIndexerModule } from '@garcon/server-agent-common/transcript-projection/index-source';

export default createJournalTranscriptIndexerModule(
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
);
