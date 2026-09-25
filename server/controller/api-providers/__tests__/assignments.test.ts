import { afterEach, expect, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiProviderAssignmentStore } from '../assignments.js';
import { ApiProviderAccess } from '../access.js';
import { ApiProviderStore } from '../store.js';
import { ApiProviderEndpointResolver } from '../endpoint-resolver.js';
import { ApiProviderService } from '../service.js';
import { AtomicJsonWriteError } from '../../../common/json-file-store.js';
import { DomainError } from '../../../common/domain-error.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const remote = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const input = { templateId: 'custom' as const, label: 'Synthetic profile', protocol: 'openai-compatible' as const,
  baseUrl: 'http://localhost:1234/v1', apiKey: 'synthetic-key', defaultModel: 'synthetic-model',
  models: [{ value: 'synthetic-model', label: 'Synthetic model', supportsImages: true }],
  supportsImages: true, modelDiscovery: 'openai-models' as const };

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'provider-assignments-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApiProviderStore(join(root, 'api-providers.json'));
  await store.init();
  const assignments = new ApiProviderAssignmentStore(root, () => () => {});
  await assignments.migrate([], []);
  await assignments.initialize();
  const access = new ApiProviderAccess(store, assignments, (id) => ['local', remote, other].includes(id));
  const provider = await store.createApiProvider(input);
  const reference = { kind: 'api-provider-endpoint' as const, apiProviderId: provider.id, endpointId: provider.endpoints[0]!.id, revision: provider.revision };
  return { root, store, assignments, access, provider, reference };
}

test('explicit grants include Local, inherit all endpoints, and persist independent concurrent changes', async () => {
  const { root, assignments, access, provider, reference } = await fixture();
  expect(access.list('local')).toEqual([]);
  expect(() => access.resolveCredential(remote, reference)).toThrow('unavailable');
  const localGrant = access.assign('local', provider.id);
  const remoteGrant = access.assign(remote, provider.id);
  await localGrant;
  await remoteGrant;
  const revision = assignments.snapshot().revision;
  await access.assign(remote, provider.id);
  expect(assignments.snapshot().revision).toBe(revision);
  expect(access.resolveCredential(remote, reference).value).toBe('synthetic-key');
  expect(() => access.resolveCredential(other, reference)).toThrow('unavailable');
  expect(() => access.resolveCredential(other, { ...reference, executorId: remote } as typeof reference)).toThrow(
    expect.objectContaining({ code: 'API_PROVIDER_UNAVAILABLE', outcome: 'rejected' }),
  );
  await assignments.unassign(remote, provider.id);
  expect(access.resolveCredential('local', reference).value).toBe('synthetic-key');
  const reopened = new ApiProviderAssignmentStore(root, () => () => {});
  await reopened.initialize();
  expect(reopened.snapshot()).toEqual(assignments.snapshot());
  await reopened.prune([]);
  expect(reopened.snapshot().assignments[remote]).toBeUndefined();
  expect(reopened.allows('local', provider.id)).toBe(true);
});

test('metadata revision, assignment and provider/endpoint identity are checked at credential release', async () => {
  const { access, store, provider, reference, assignments } = await fixture();
  await access.assign(remote, provider.id);
  expect(() => access.resolveCredential(remote, { ...reference, endpointId: 'wrong_endpoint' })).toThrow('does not belong');
  const resolver = new ApiProviderEndpointResolver((executor) => access.list(executor), (_agent, executor) => executor === remote ? ['openai-compatible'] : [], () => store.list());
  const selection = resolver.resolveSelection({ executorId: remote, agentId: 'test', model: 'synthetic-model', apiProviderId: provider.id, modelEndpointId: reference.endpointId });
  expect(selection.endpoint?.credential?.revision).toBe(1);
  expect(resolver.getModelOptions('test', 'local')).toEqual([]);
  await store.updateApiProvider(provider.id, { revision: 1, endpoint: { apiKey: 'rotated-key' } });
  expect(() => access.resolveCredential(remote, reference)).toThrow('configuration changed');
  expect(() => resolver.resolveEndpointReference(selection)).toThrow('configuration changed');
  await expect(store.updateApiProvider(provider.id, { revision: 1, label: 'Stale edit' })).rejects.toMatchObject({ code: 'API_PROVIDER_CONFIGURATION_CHANGED' });
  await store.updateApiProvider(provider.id, { revision: 2, endpoint: { clearApiKey: true } });
  expect(access.resolveCredential(remote, { ...reference, revision: 3 }).value).toBe('');
  await assignments.unassign(remote, provider.id);
  expect(() => access.resolveCredential(remote, { ...reference, revision: 3 })).toThrow('unavailable');
  expect(resolver.describePrevious({ model: 'synthetic-model', apiProviderId: provider.id, modelEndpointId: reference.endpointId }).isLocal).toBe(false);
});

test.each(['profile-write-unknown', 'assignment-write-unknown'] as const)(
  'provider storage failure omits endpoint models without authorizing their use: %s', async (failureMode) => {
    const { root, store, assignments, access, provider, reference } = await fixture();
    await access.assign(remote, provider.id);
    const resolver = new ApiProviderEndpointResolver((executor) => access.list(executor), () => ['openai-compatible']);
    const service = new ApiProviderService({ store, access, isApiProviderReferenced: () => false, discoverModels: async () => ({ success: true }) });
    const input = { executorId: remote, agentId: 'test', model: 'synthetic-model', apiProviderId: provider.id, modelEndpointId: reference.endpointId };
    const selection = resolver.resolveSelection(input);
    expect(resolver.getModelOptions('test', remote)).toHaveLength(1);
    {
      const open = fs.open;
      const failure = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
        if (path === root && flags === 'r') throw new Error('Synthetic sync failure');
        return open(path, flags, mode);
      });
      try {
        await expect(failureMode === 'profile-write-unknown'
          ? store.updateApiProvider(provider.id, { label: 'Updated profile' })
          : assignments.unassign(remote, provider.id)).rejects.toThrow('Synthetic sync failure');
      } finally { failure.mockRestore(); }
    }
    expect(resolver.getModelOptions('test', remote)).toEqual([]);
    expect(resolver.getModelOptions('test', 'local')).toEqual([]);
    expect(service.getCatalog(remote)).toEqual([]);
    const unavailable = expect.objectContaining({ code: 'API_PROVIDER_STORAGE_UNAVAILABLE' });
    expect(() => service.management()).toThrow(unavailable);
    expect(() => access.list(remote)).toThrow(unavailable);
    expect(() => resolver.resolveSelection(input)).toThrow(unavailable);
    expect(() => resolver.modelSupportsImages(input)).toThrow(unavailable);
    expect(() => resolver.resolveEndpointReference(selection)).toThrow(unavailable);
    expect(() => access.resolveCredential(remote, reference)).toThrow(
      expect.objectContaining({ code: 'API_PROVIDER_STORAGE_UNAVAILABLE', outcome: 'rejected' }),
    );
    expect(resolver.resolveSelection({ executorId: remote, agentId: 'test', model: 'native-model' })).toMatchObject({ model: 'native-model', apiProviderId: null });
  },
);

test('catalog listing does not suppress executor or unexpected provider errors', () => {
  for (const error of [new DomainError('EXECUTOR_NOT_FOUND', 'Missing executor', 404), new Error('Unexpected failure')]) {
    const resolver = new ApiProviderEndpointResolver(() => { throw error; });
    expect(() => resolver.getModelOptions('test', remote)).toThrow(error);
  }
});

test('migration grants only the legacy seed once, never newer profiles or executors', async () => {
  const { root, store, provider } = await fixture();
  const legacy = { ...provider };
  delete (legacy as Partial<typeof provider>).revision;
  await fs.writeFile(join(root, 'api-providers.json'), JSON.stringify({ version: 1, apiProviders: [legacy] }));
  await store.init();
  const newer = await store.createApiProvider({ ...input, label: 'New profile' });
  expect(store.legacyProviderIds).toEqual([provider.id]);
  const workspace = join(root, 'old-workspace');
  const assignments = new ApiProviderAssignmentStore(workspace, () => () => {});
  await assignments.migrate(['local', remote], store.legacyProviderIds);
  await assignments.initialize();
  expect(assignments.allows(remote, provider.id)).toBe(true);
  expect(assignments.allows(remote, newer.id)).toBe(false);
  expect(assignments.allows(other, provider.id)).toBe(false);
  await assignments.unassign(remote, provider.id);
  await assignments.migrate(['local', remote, other], store.legacyProviderIds);
  await assignments.initialize();
  expect(assignments.allows(remote, provider.id)).toBe(false);
  expect(assignments.allows(other, provider.id)).toBe(false);
});

test('corrupt or missing post-migration assignments never grant legacy access', async () => {
  const { root, assignments, provider } = await fixture();
  await fs.writeFile(join(root, 'api-provider-assignments.json'), JSON.stringify({ version: 1, revision: 0, assignments: { [remote]: [provider.id, provider.id] } }));
  await expect(assignments.initialize()).rejects.toThrow('corrupt');
  await expect(assignments.migrate([remote], [provider.id])).rejects.toThrow('corrupt');
  const missing = new ApiProviderAssignmentStore(join(root, 'missing'), () => () => {});
  await expect(missing.initialize()).rejects.toThrow('missing');
  expect(() => missing.allows(remote, provider.id)).toThrow('unavailable');
});

test.each([false, true])('assignment write failure never reports or authorizes a grant (renamed: %s)', async (renamed) => {
  const { root, assignments, provider } = await fixture();
  const open = fs.open;
  const failure = renamed ? spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (path === root && flags === 'r') throw new Error('Synthetic sync failure');
    return open(path, flags, mode);
  }) : spyOn(fs, 'rename').mockRejectedValue(new Error('Synthetic write failure'));
  try { await expect(assignments.assign(remote, provider.id)).rejects.toThrow('Synthetic'); }
  finally { failure.mockRestore(); }
  if (renamed) expect(() => assignments.allows(remote, provider.id)).toThrow('unavailable');
  else expect(assignments.allows(remote, provider.id)).toBe(false);
});

test('create keeps an identifiable unassigned profile when executor assignment fails', async () => {
  const { store, assignments, access } = await fixture();
  const failure = spyOn(assignments, 'assign').mockRejectedValue(new Error('Synthetic write failure'));
  const service = new ApiProviderService({ store, access, isApiProviderReferenced: () => false, discoverModels: async () => ({ success: true }) });
  try {
    const created = await service.create({ label: input.label, templateId: input.templateId, endpoint: input }, remote);
    expect(created.assignment).toMatchObject({ executorId: remote, status: 'not-assigned' });
    expect(store.getApiProvider(created.id)).not.toBeNull();
    expect(access.list(remote)).toEqual([]);
  } finally { failure.mockRestore(); }
});

test('create distinguishes an uncertain assignment from a definite unassigned profile', async () => {
  const { store, assignments, access } = await fixture();
  const failure = spyOn(assignments, 'assign').mockRejectedValue(new AtomicJsonWriteError('Synthetic unknown write', true));
  const service = new ApiProviderService({ store, access, isApiProviderReferenced: () => false, discoverModels: async () => ({ success: true }) });
  try {
    const created = await service.create({ label: input.label, templateId: input.templateId, endpoint: input }, remote);
    expect(created.assignment.status).toBe('unknown');
    expect(store.getApiProvider(created.id)).not.toBeNull();
  } finally { failure.mockRestore(); }
});

test('one controller serializes concurrent profile mutations', async () => {
  const { store } = await fixture();
  const first = store.createApiProvider({ ...input, label: 'First account' });
  const second = store.createApiProvider({ ...input, label: 'Second account' });
  await first;
  await second;
  expect(store.list().map((entry) => entry.label).sort()).toEqual(['First account', 'Second account', 'Synthetic profile']);
});

test.each([false, true])('profile deletion fails closed on uncertain persistence (renamed: %s)', async (renamed) => {
  const { root, store, provider, access, reference } = await fixture();
  await access.assign(remote, provider.id);
  const open = fs.open;
  const failure = renamed ? spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (path === root && flags === 'r') throw new Error('Synthetic sync failure');
    return open(path, flags, mode);
  }) : spyOn(fs, 'rename').mockRejectedValue(new Error('Synthetic write failure'));
  try { await expect(store.deleteApiProvider(provider.id, () => false)).rejects.toThrow('Synthetic'); }
  finally { failure.mockRestore(); }
  if (renamed) {
    expect(() => access.resolveCredential(remote, reference)).toThrow('durability');
    expect(() => store.referenceWrites.retain([provider.id])).toThrow('durability');
  } else expect(access.resolveCredential(remote, reference).value).toBe('synthetic-key');
});

test.each(['openai-compatible', 'anthropic-messages'] as const)('long labels generate readable bounded %s identities', async (protocol) => {
  const { root, store } = await fixture();
  for (const length of [51, 64, 1000]) {
    const profile = await store.createApiProvider({ ...input, protocol, label: 'a'.repeat(length) });
    expect(profile.endpoints[0]!.id.length).toBeLessThanOrEqual(64);
    expect(store.getApiProvider(profile.id)?.label).toHaveLength(length);
  }
  const reopened = new ApiProviderStore(join(root, 'api-providers.json'));
  await reopened.init();
  expect(reopened.list()).toHaveLength(4);
});

test('missing historical model classification cannot authorize switching a local session to cloud', async () => {
  const { store, provider, access, reference } = await fixture();
  await access.assign(remote, provider.id);
  await store.updateApiProvider(provider.id, { endpoint: { models: [{ value: 'synthetic-model', label: 'Synthetic', isLocal: true }] } });
  const resolver = new ApiProviderEndpointResolver((executor) => access.list(executor), () => ['openai-compatible'], () => store.list());
  const selection = { model: 'synthetic-model', apiProviderId: provider.id, modelEndpointId: reference.endpointId };
  expect(resolver.describePrevious(selection).isLocal).toBe(true);
  await store.updateApiProvider(provider.id, { endpoint: { defaultModel: 'replacement', models: [{ value: 'replacement', label: 'Replacement' }] } });
  expect(() => resolver.describePrevious(selection)).toThrow('classification is unknown');
});
