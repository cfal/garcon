import { createPathNativeSessionCodec } from '../../../../server-agents/common/src/native-session/path-native-session.ts';
import { createClaudeNativeActivityProbe } from '../../../../server-agents/claude/src/agents/claude/native-activity.ts';

const nativePath = process.argv[2];
const nativeSessions = createPathNativeSessionCodec('claude');
const ref = nativeSessions.encode({ path: nativePath, agentSessionId: 'synthetic-session', modelEndpointId: null });
const result = await createClaudeNativeActivityProbe(nativeSessions)
  .lastActivity(ref!, new AbortController().signal);
process.stdout.write(JSON.stringify(result));
