import { isRuntimeProbeChallenge } from '@garcon/common/server-runtime';
import { createServerRuntimeProof, type ServerRuntimeState } from './server-runtime.js';

export function runtimeProofResponse(runtime: ServerRuntimeState, url: URL): Response {
  const challenge = url.searchParams.get('challenge');
  if (!isRuntimeProbeChallenge(challenge)) {
    return Response.json({ error: 'challenge must be 32-byte base64url data' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return Response.json({
    schemaVersion: runtime.identity.schemaVersion,
    instanceId: runtime.identity.instanceId,
    proof: createServerRuntimeProof(runtime, challenge),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
