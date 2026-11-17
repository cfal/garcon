import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { protocolReviewProblem, protocolRevision, requiresProtocolReview, sharedWireFiles } from '../protocol-review-gate.ts';

test('every curated wire source names an existing module', () => {
  for (const file of sharedWireFiles) expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true);
  expect(requiresProtocolReview('common/transcript-seed.ts')).toBe(true);
});

test('wire review covers both historical missed protocol bumps', () => {
  // 27eb5a41d added a rendered Pi message; a8a913dea added Shell Notes manifest fields.
  for (const [before, files] of [
    [2, ['common/chat-types.ts', 'common/transcript-seed.ts']],
    [26, ['common/agents.ts', 'server-agents/interface/src/contracts/services.ts']],
  ]) expect(protocolReviewProblem({ files, before, after: before, message: 'New capability' })).not.toBeNull();
});

test('a bump or a substantive unchanged declaration records the review', () => {
  const input = { files: ['common/chat-types.ts'], before: 44, after: 44, message: 'Refactor' };
  expect(protocolReviewProblem({ ...input, after: 45 })).toBeNull();
  expect(protocolReviewProblem({ ...input, message: 'Refactor\n\nProtocol-Unchanged: Moves helpers without changing payloads.' })).toBeNull();
  expect(protocolReviewProblem({ ...input, message: 'Protocol-Unchanged:' })).not.toBeNull();
  expect(protocolReviewProblem({ ...input, after: 43 })).not.toBeNull();
  expect(protocolReviewProblem({ ...input, files: ['web/src/lib/components/Example.svelte'] })).toBeNull();
});

test('recognizes protocol, routing, framing and derived interface contracts without all common sources', () => {
  for (const file of ['server/remote/transport/cli-protocol.ts', 'server/remote/transport/rpc-routing.ts',
    'server/remote/transport/websocket-link.ts', 'server-agents/interface/src/contracts/services.ts']) {
    expect(requiresProtocolReview(file)).toBe(true);
  }
  expect(requiresProtocolReview('common/local-calendar.ts')).toBe(false);
  expect(protocolRevision('export const EXECUTOR_PROTOCOL_REVISION = 44;')).toBe(44);
  expect(() => protocolRevision('const revision = 44')).toThrow();
});
