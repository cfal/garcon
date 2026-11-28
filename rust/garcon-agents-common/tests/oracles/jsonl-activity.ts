import { createJsonlNativeActivityProbe } from '../../../../server-agents/common/src/native-session/jsonl-activity.ts';
import { createPathNativeSessionCodec } from '../../../../server-agents/common/src/native-session/path-native-session.ts';

const nativeSessions = createPathNativeSessionCodec('test');
const ref = nativeSessions.encode({
  path: Bun.argv[2]!,
  agentSessionId: 'session-1',
  modelEndpointId: null,
})!;
const outcomes = [];
for (const maxTailBytes of [undefined, 50, 8]) {
  const probe = createJsonlNativeActivityProbe({
    nativeSessions,
    ...(maxTailBytes === undefined ? {} : { maxTailBytes }),
    activityTimestamp(entry) {
      if (!entry || typeof entry !== 'object' || !('type' in entry) || entry.type !== 'message') {
        return undefined;
      }
      return 'timestamp' in entry && typeof entry.timestamp === 'string' ? entry.timestamp : null;
    },
  });
  outcomes.push(await probe.lastActivity(ref, new AbortController().signal));
}
process.stdout.write(JSON.stringify(outcomes));
