import { DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID } from '@garcon/common/agents';
import { createDirectTranscriptIndexerModule } from '@garcon/server-agent-common/direct/transcript-index-source';

export default createDirectTranscriptIndexerModule(
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
);
