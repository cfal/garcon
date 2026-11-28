import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '../../../../server/common/domain-error.ts';
import { ExecutorManager } from '../../../../server/controller/executors/manager.ts';

const id = '11111111-1111-4111-8111-111111111111';
const target = { executorId: id, agentId: 'test' };

export async function executorManagerTrace(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), 'garcon-manager-oracle-'));
  try {
    await writeFile(join(root, 'executors.json'), JSON.stringify({ version: 1, executors: [{
      id, label: 'Synthetic worker', enabled: true, secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      connection: { kind: 'executor-connects', advertisedUrl: null }, noTls: true,
    }] }), { mode: 0o600 });
    const manager = await ExecutorManager.create({
      id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
    });
    const effects: unknown[] = [];
    const off = manager.onChanged(() => effects.push('changed'));
    const offAvailability = manager.onAvailabilityChanged((_, value) => effects.push(value));
    const initialLink = manager.inboundLink(id);
    if (scenario === 'wire') {
      try {
        return JSON.stringify(manager.list(), (key, value) => {
          if (value !== null && key === 'projectBasePath') return '/synthetic';
          if (value !== null && key === 'instanceId') return 'synthetic-instance';
          return value;
        });
      } finally { off(); offAvailability(); await manager.dispose(); }
    }
    const mutationError = async (work: () => unknown) => {
      try { await work(); return null; }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return { code: error.code, message: error.message, status: error.status, retryable: error.retryable };
      }
    };
    const read = () => manager.list().map(item => ({
      id: item.id, label: item.label, availability: item.availability, enabled: item.enabled,
      allowControllerCli: item.allowControllerCli, allowExecutorManagement: item.allowExecutorManagement,
    }));
    let error: unknown = null;
    try {
      if (scenario === 'offline') {
        error = await mutationError(() => manager.requireExecutor(id));
      } else if (scenario === 'retain') {
        const release = manager.retainReferences([id], []);
        error = await mutationError(() => manager.remove(id));
        release();
        await manager.remove(id);
      } else if (scenario === 'disruptive' || scenario === 'grants') {
        manager.setGuards({ assertIdle() {
          effects.push('idle');
          throw new DomainError('EXECUTOR_IN_USE', 'Synthetic active work', 409);
        }, assertRemovable() {} });
        error = await mutationError(() => manager.update(id, scenario === 'disruptive' ? { enabled: false } : {
          allowControllerCli: true, allowExecutorManagement: true,
        }));
      } else if (scenario === 'quiesced' || scenario === 'disposed') {
        if (scenario === 'quiesced') manager.quiesce();
        else await manager.dispose();
        error = await mutationError(() => manager.retainReferences([id], []));
        manager.retainReferences([], [id])();
        effects.push((await mutationError(() => manager.remove(id)))?.code);
      } else if (scenario === 'deleted') {
        await manager.remove(id);
        error = await mutationError(() => manager.retainReferences([id], []));
      } else if (scenario === 'changing') {
        const remove = manager.config.remove.bind(manager.config);
        manager.config.remove = async (targetId) => {
          error = await mutationError(() => manager.retainReferences([targetId], []));
          await remove(targetId);
        };
        await manager.remove(id);
      } else if (scenario === 'revoked') {
        const first = manager.update(id, { label: 'Renamed' });
        error = await mutationError(() => manager.remove(id, () => {
          effects.push(manager.config.require(id).label);
          throw new DomainError('CLI_ACCESS_DENIED', 'Synthetic grant revoked', 403);
        }));
        await first;
      }
      return {
        snapshots: read(), error, effects, localReady: manager.isReady('local'),
        reconnecting: manager.isReconnecting(id), known: manager.knownIntegration(target) !== null,
        retainedLink: manager.inboundLink(id) === initialLink,
      };
    } finally {
      off(); offAvailability(); await manager.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
