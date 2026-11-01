import { createHmac, randomBytes } from 'node:crypto';
import { version } from '../../../package.json';
import { testRoleContracts } from './test-session-transport.js';
import { protocolProfileId, type ProtocolDecision } from '../transport/protocol-compatibility.js';
import { selectProtocol, type ProtocolOffer } from '@garcon/common/protocol-contracts';
import { proofPayload, type LinkHello, type LinkRole } from '../transport/link-handshake.js';

export function primaryHello(role: LinkRole): LinkHello {
  return {
    type: 'hello', build: version, protocol: testRoleContracts(role).offer, role,
    executorId: role === 'controller' ? 'synthetic-executor' : null,
    runtimeId: crypto.randomUUID(), nonce: randomBytes(32).toString('hex'),
    lane: 'primary', sessionId: role === 'controller' ? crypto.randomUUID() : null, primarySessionId: null, primaryProfileId: null,
  };
}

export function signedProof(secret: string, role: LinkRole, local: string, peer: string, decision: ProtocolDecision) {
  const payload = role === 'controller' ? proofPayload(role, local, peer, decision) : proofPayload(role, peer, local, decision);
  return { type: 'proof', decision, signature: createHmac('sha256', secret).update(payload).digest('hex') };
}

export function selectedDecision(local: ProtocolOffer, peer: ProtocolOffer): ProtocolDecision {
  const result = selectProtocol(local, peer);
  return result.ok ? { ok: true, profileId: protocolProfileId(result.profile) } : result;
}
