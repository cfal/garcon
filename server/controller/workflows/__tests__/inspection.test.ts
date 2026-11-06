import { afterEach, expect, test } from 'bun:test';
import { WORKFLOW_LIMITS, type WorkflowArtifact } from '../../../../common/workflows.js';
import { workflowJson } from '../http.js';
import { workflowDigest } from '../inputs.js';
import { integrationFixture } from './integration-fixture.js';
import { WorkflowAttempts } from '../attempts.js';
import { fixture, plan } from './fixture.js';

const fixtures: ReturnType<typeof integrationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

test('overview excludes full execution manifests and evidence; byte-short artifact pages remain complete', async () => {
  const f = integrationFixture(); fixtures.push(f); await f.produce();
  const source = f.service.artifacts(f.id)[0]!;
  const ids: string[] = [];
  f.store.transaction(db => {
    for (let i = 0; i < 45; i++) {
      const { digest: _digest, ...content } = { ...source, id: `synthetic-evidence-${String(i).padStart(3, '0')}`,
        summary: 'Synthetic evidence. '.repeat(2800) };
      const artifact: WorkflowArtifact = { ...content, digest: workflowDigest(content) };
      ids.push(artifact.id);
      const payload = JSON.stringify(artifact);
      expect(Buffer.byteLength(payload)).toBeLessThan(WORKFLOW_LIMITS.evidenceBytes);
      db.query('INSERT INTO artifacts VALUES (?,?,?)').run(artifact.id, source.attempt.attemptId, payload);
    }
  });
  const overview = f.service.overview(f.id);
  expect(Object.hasOwn(overview, 'artifacts')).toBe(false);
  expect(Object.hasOwn(overview.draft, 'plan')).toBe(false);
  expect(Object.hasOwn(overview.tasks[0]!.attempt!, 'effectiveInput')).toBe(false);
  expect(Buffer.byteLength(await workflowJson(overview).text())).toBeLessThan(32 * 1024);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = f.service.artifacts(f.id, cursor, 50);
    expect(Buffer.byteLength(await workflowJson({ artifacts: page }).text())).toBeLessThan(WORKFLOW_LIMITS.pageBytes);
    if (!page.length) break;
    expect(page.length).toBeLessThan(50);
    seen.push(...page.map(artifact => artifact.id)); cursor = page.at(-1)!.id;
  }
  expect(ids.every(id => seen.includes(id))).toBe(true);
  expect(new Set(seen).size).toBe(seen.length);
});

test('catalog uses current projections and retains historical resource attention without loading manifests', () => {
  const f = fixture();
  try {
    const id = f.create().workflowId;
    expect(f.service.list().workflows[0]).toMatchObject({ goal: 'artifacts', totalTasks: 1,
      completedTasks: 0, attentionTasks: 0, attentionOperations: 0, executorIds: ['local'] });
    f.activate(id);
    const attempt = new WorkflowAttempts(f.store, { now: () => '2026-01-01' }).reserve(id, 'check')!;
    f.store.transaction(db => {
      db.query("UPDATE attempts SET resolution='succeeded',dispatch_phase='settled',control_state='released' WHERE id=?").run(attempt.attemptId);
      db.query("INSERT INTO operation_intents VALUES ('old-cleanup',?,'cleanup','old-resource','unknown','{}',NULL,0,NULL)").run(attempt.attemptId);
    });
    expect(f.service.list().workflows[0]).toMatchObject({ completedTasks: 1, attentionOperations: 1 });
    f.write({ action: 'plan', workflowId: id, expectedPlanRevision: 1, plan: { ...plan(), tasks: [
      { ...plan().tasks[0]!, id: 'replacement' }], goal: { kind: 'artifacts', taskIds: ['replacement'] } } });
    expect(f.service.list().workflows[0]!.completedTasks).toBe(1);
    f.activate(id);
    expect(f.service.list().workflows[0]).toMatchObject({ completedTasks: 0, attentionOperations: 1 });
  } finally { f.cleanup(); }
});

test('large gate evidence is summarized below the response bound without rewriting full observations', async () => {
  const f = integrationFixture(); fixtures.push(f); await f.produce();
  const source = f.service.artifacts(f.id)[0]!;
  const manifest = { ...f.service.detail(f.id).activationManifest, gateId: 'wide-gate', artifacts: [] as { id: string; digest: string }[] };
  f.store.transaction(db => {
    for (let i = 0; i < 510; i++) {
      const { digest: _digest, ...content } = { ...source, id: `wide-evidence-${i}`,
        summary: '\u6f22'.repeat(4096), commandOutcome: { outcome: 'finished' as const, exitCode: 0, signal: null,
          capture: 'complete' as const, cwd: { kind: 'reported' as const, path: '/' + 'x'.repeat(8000) } } };
      const artifact = { ...content, digest: workflowDigest(content) };
      db.query('INSERT INTO artifacts VALUES (?,?,?)').run(artifact.id, source.attempt.attemptId, JSON.stringify(artifact));
      manifest.artifacts.push({ id: artifact.id, digest: artifact.digest });
    }
    db.query('INSERT INTO gate_manifests VALUES (?,?,?,?)').run(f.id, manifest.gateId, workflowDigest(manifest), JSON.stringify(manifest));
  });
  const gate = f.service.inspectGate(f.id, manifest.gateId);
  expect(gate.evidence).toHaveLength(510);
  expect(gate.evidence[0]).toMatchObject({ summaryTruncated: true, commandOutcome: { exitCode: 0, capture: 'complete' } });
  expect(gate.evidence[0]!.commandOutcome).not.toHaveProperty('cwd');
  expect(Buffer.byteLength(await workflowJson(gate).text())).toBeLessThan(WORKFLOW_LIMITS.pageBytes);
  expect(f.service.artifacts(f.id).find(artifact => artifact.id === 'wide-evidence-0')!.summary).toHaveLength(4096);
});

test('refused cleanup attention retires with its exact claim while the operation history remains', async () => {
  const f = integrationFixture(); fixtures.push(f); await f.produce();
  const attempt = f.service.attempts(f.id).find(attempt => attempt.taskId === 'source0')!;
  const key = attempt.managedTarget!.resourceKey;
  f.store.transaction(db => db.query("INSERT INTO operation_intents VALUES ('refused-cleanup',?,'cleanup',?,'not-started','{}',NULL,0,NULL)")
    .run(attempt.attemptId, key));
  expect(f.service.list().workflows[0]!.attentionOperations).toBe(1);
  expect(f.service.overview(f.id).operations.map(operation => operation.id)).toContain('refused-cleanup');
  f.store.transaction(db => db.query('DELETE FROM resource_claims WHERE attempt_id=? AND resource_key=?').run(attempt.attemptId, key));
  expect(f.service.list().workflows[0]!.attentionOperations).toBe(0);
  expect(f.service.overview(f.id).operations).toEqual([]);
  expect(f.service.inspectAttempt(f.id, attempt.attemptId).operations.map(operation => operation.id)).toContain('refused-cleanup');
});
