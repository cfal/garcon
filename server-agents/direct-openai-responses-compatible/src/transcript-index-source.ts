import { DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID } from '@garcon/common/agents';
import { createDirectTranscriptIndexerModule } from '@garcon/server-agent-common/direct/transcript-index-source';

export default createDirectTranscriptIndexerModule(
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
);
