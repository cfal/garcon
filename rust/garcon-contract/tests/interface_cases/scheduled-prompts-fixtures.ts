import { normalizeScheduledPromptTarget } from '../../../../common/scheduled-prompts.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const settings = JSON.parse('{"codex":{"ownerId":"codex","schemaVersion":1.0,"values":{"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0},"extra":true}}');
const input = {
  type: 'new-chat', agentId: 'codex', projectPath: '/synthetic', model: 'example',
  apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
  agentSettingsById: settings, preambleChoice: { mode: 'defaults' },
};
const raw = JSON.stringify(input).replace(JSON.stringify(settings), '{"codex":{"ownerId":"codex","schemaVersion":1.0,"values":{"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0},"extra":true}}');
const expected = JSON.stringify(normalizeScheduledPromptTarget(JSON.parse(raw)));
console.log(JSON.stringify({ raw, expected }));
