import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiProviderStore } from '../../../server/controller/api-providers/store.ts';
import { ApiProviderAssignmentStore } from '../../../server/controller/api-providers/assignments.ts';

const [mode, config, workspace] = Bun.argv.slice(2);
const profilesPath = join(config, 'api-providers.json');
const assignmentsPath = join(workspace, 'api-provider-assignments.json');
const profiles = new ApiProviderStore(profilesPath);
const assignments = new ApiProviderAssignmentStore(workspace, () => () => {});
if (mode === 'seed') {
  await mkdir(workspace, { recursive: true });
  await ApiProviderAssignmentStore.initializeFreshWorkspace(workspace);
  await profiles.init();
  await assignments.initialize();
  const profile = await profiles.createApiProvider({
    templateId: 'openrouter', label: 'Bun fixture', protocol: 'openai-compatible',
    baseUrl: 'https://provider.example.invalid/v1', apiKey: 'BunSyntheticKey',
    capabilities: { chatCompletions: true, responses: true }, defaultModel: 'default',
    models: [{ value: 'other', label: 'Other' }], supportsImages: true, modelDiscovery: 'openrouter-models',
  });
  await assignments.assign('local', profile.id);
  console.log(JSON.stringify({ id: profile.id, assignments: assignments.snapshot() }));
} else if (mode === 'check-and-change') {
  const priorProfiles = await readFile(profilesPath, 'utf8');
  const priorAssignments = await readFile(assignmentsPath, 'utf8');
  await profiles.init();
  await assignments.initialize();
  const first = profiles.list()[0];
  await assignments.setProviderExecutors(first.id, []);
  const bytesMatch = priorProfiles === await readFile(profilesPath, 'utf8')
    && priorAssignments === await readFile(assignmentsPath, 'utf8');
  await profiles.updateApiProvider(first.id, { label: 'Bun renamed', endpoint: { clearApiKey: true } });
  await assignments.assign('local', first.id);
  console.log(JSON.stringify({ bytesMatch, profiles: profiles.redactedList(), assignments: assignments.snapshot() }));
} else {
  throw new Error(`Unknown provider oracle mode: ${mode}`);
}
