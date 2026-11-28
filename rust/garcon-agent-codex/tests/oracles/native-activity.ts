import { createPathNativeSessionCodec } from '../../../../server-agents/common/src/native-session/path-native-session.ts';
import { createCodexNativeActivityProbe } from '../../../../server-agents/codex/src/agents/codex/native-activity.ts';

const nativeSessions = createPathNativeSessionCodec('codex');
const ref = nativeSessions.encode({ path: process.argv[2], agentSessionId: 'synthetic-session', modelEndpointId: null });
const result = await createCodexNativeActivityProbe(nativeSessions).lastActivity(ref!, new AbortController().signal);
process.stdout.write(JSON.stringify(result));
