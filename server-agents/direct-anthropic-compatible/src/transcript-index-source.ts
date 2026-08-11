import { DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID } from '@garcon/common/agents';
import { createJournalTranscriptIndexerModule } from '@garcon/server-agent-common/transcript-projection/index-source';

export default createJournalTranscriptIndexerModule(DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID);
