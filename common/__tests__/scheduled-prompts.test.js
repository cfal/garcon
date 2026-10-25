import { describe, expect, it } from 'bun:test';
import {
  SCHEDULED_PROMPT_CHAT_ID_TOKEN,
  SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX,
  SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN,
  SCHEDULED_PROMPT_MAX_LENGTH,
  normalizeScheduledPrompt,
  normalizeCreateScheduledPromptResponse,
  normalizeScheduledPromptDefinitionInput,
  normalizeScheduledPromptTarget,
  renderScheduledPrompt,
  renderScheduledChatTitle,
  normalizeScheduledPromptsSnapshot,
  scheduledPromptFitsRenderedLimit,
} from '../scheduled-prompts.js';
import { PREAMBLE_MAX_COUNT } from '../preambles.js';
import { TEMPLATE_VALIDATION_VALUES } from '../template-tokens.js';

const CHAT_ID = '1783725900000000';
const VALUES = { ...TEMPLATE_VALIDATION_VALUES, chat_id: CHAT_ID };
const PREAMBLE_A = '00000000-0000-4000-8000-000000000001';
const PREAMBLE_B = '00000000-0000-4000-8000-000000000002';

it('confirms a created record only when the same record is in its atomic snapshot', () => {
  const scheduledPrompt = normalizeScheduledPrompt({ ...definition('Synthetic input'),
    id: '11111111-1111-4111-8111-111111111111', enabled: true,
    schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
    createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z',
  });
  const response = { success: true, scheduledPrompt, snapshot: { revision: 1, prompts: [scheduledPrompt], runLog: [] } };
  expect(normalizeCreateScheduledPromptResponse(response)).toEqual(response);
  for (const invalid of [null, {}, { ...response, success: false }, { ...response, scheduledPrompt: undefined },
    { ...response, snapshot: { ...response.snapshot, prompts: [] } },
    { ...response, scheduledPrompt: { ...scheduledPrompt, prompt: 'Different input' } },
  ]) expect(normalizeCreateScheduledPromptResponse(invalid)).toBeNull();
});

describe('scheduled execution selection', () => {
  const expectedSelection = { agentId: 'synthetic-literal', agentOwnershipEpoch: 'synthetic-epoch', model: 'notes' };

  it('retains the captured selection through definitions, persistence, and snapshots', () => {
    const input = definition('  Synthetic note\n');
    input.target.expectedSelection = expectedSelection;
    const normalized = normalizeScheduledPromptDefinitionInput(input);
    expect(normalized.target.expectedSelection).toEqual(expectedSelection);
    const record = normalizeScheduledPrompt({ ...normalized, id: 'synthetic-schedule', enabled: true,
      schedule: { type: 'once', nextRunAt: input.schedule.runAtUtc },
      createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z' });
    expect(normalizeScheduledPromptsSnapshot({ revision: 1, prompts: [record], runLog: [] }).prompts[0].target.expectedSelection)
      .toEqual(expectedSelection);
  });

  it('rejects malformed selection guards instead of dropping them', () => {
    const target = definition('Body').target;
    for (const guard of [
      null,
      false,
      {},
      { ...expectedSelection, agentId: '' },
      { ...expectedSelection, agentId: ' \t' },
      { ...expectedSelection, agentOwnershipEpoch: 1 },
      { ...expectedSelection, agentOwnershipEpoch: ' \t' },
      { ...expectedSelection, model: 1 },
      { agentId: 'synthetic-literal', model: 'notes' },
      { agentId: 'synthetic-literal', agentOwnershipEpoch: 'synthetic-epoch' },
    ]) {
      expect(normalizeScheduledPromptTarget({ ...target, expectedSelection: guard })).toBeNull();
    }
    expect(normalizeScheduledPromptTarget(target)).toEqual(target);
  });

  it.each([
    { agentId: 'synthetic-literal', agentOwnershipEpoch: null, model: null },
    { ...expectedSelection, model: '' },
    { agentId: ' synthetic-literal ', agentOwnershipEpoch: ' synthetic-epoch ', model: ' notes ' },
  ])('preserves valid selection fields without normalizing their values: %j', selection => {
    const target = { ...definition('Body').target, expectedSelection: selection };
    expect(normalizeScheduledPromptTarget(target)).toEqual(target);
  });
});

describe('scheduled task names and titles', () => {
  it('normalizes static optional names, preserving Unicode code points', () => {
    for (const name of [undefined, '', '   ']) {
      expect(normalizeScheduledPromptDefinitionInput({ ...definition('Body'), name })).not.toHaveProperty('name');
    }
    for (const name of ['Daily review', '{{current_date}}', '\u{1F680}'.repeat(120)]) {
      expect(normalizeScheduledPromptDefinitionInput({ ...definition('Body'), name: ` ${name} ` })?.name).toBe(name);
    }
    for (const name of [null, 5, 'a'.repeat(121), '\u{1F680}'.repeat(121), 'two\nlines', 'a\u0000b', 'a\u2028b', '\ud800']) {
      expect(normalizeScheduledPromptDefinitionInput({ ...definition('Body'), name })).toBeNull();
    }
  });

  it('retains names and templates through record and snapshot normalization', () => {
    const value = newChatDefinition({ mode: 'defaults' });
    value.name = '  Daily review  ';
    value.target.chatTitleTemplate = '  Review {{current_date}} / {{current_date_local}}  ';
    const normalized = normalizeScheduledPromptDefinitionInput(value);
    expect(normalized.name).toBe('Daily review');
    expect(normalized.target.chatTitleTemplate).toBe('Review {{current_date}} / {{current_date_local}}');
    expect(normalizeScheduledPromptDefinitionInput(normalized)).toEqual(normalized);
    const record = normalizeScheduledPrompt({
      ...normalized, id: 'task', schedule: { type: 'once', nextRunAt: value.schedule.runAtUtc },
      createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
    });
    expect(normalizeScheduledPromptsSnapshot({ revision: 1, prompts: [record], runLog: [] }).prompts).toEqual([record]);
    expect(record).toMatchObject({ name: normalized.name, target: normalized.target });
    expect(normalizeScheduledPrompt({ ...record, name: 123 })).toBeNull();
  });

  it('bounds source and rendered titles in UTF-8 bytes, not the agent-command character cap', () => {
    const value = newChatDefinition({ mode: 'defaults' });
    for (const chatTitleTemplate of ['a'.repeat(4096), '\u{1F680}'.repeat(1024), 'a'.repeat(4080) + '{{chat_id}}']) {
      value.target.chatTitleTemplate = chatTitleTemplate;
      expect(normalizeScheduledPromptDefinitionInput(value)?.target.chatTitleTemplate).toBe(chatTitleTemplate);
    }
    for (const chatTitleTemplate of ['', '  ', null, 123, 'a\nb', 'a\u2029b', '\ud800', 'a'.repeat(4097), '\u{1F680}'.repeat(1025), 'a'.repeat(4081) + '{{chat_id}}']) {
      value.target.chatTitleTemplate = chatTitleTemplate;
      expect(normalizeScheduledPromptDefinitionInput(value)).toBeNull();
    }
    expect(normalizeScheduledPromptDefinitionInput({ ...definition('Body'), target: {
      ...definition('Body').target, chatTitleTemplate: 'Not a rename',
    } })).toBeNull();
  });

  it('renders only runtime tokens once and revalidates the final title', () => {
    expect(renderScheduledChatTitle(' {{chat_id}} {{current_date}} {{current_date_local}} \\{{current_date}} {{arguments}} {{current_time}} ', VALUES))
      .toBe(`${CHAT_ID} 2000-01-02 2000-01-01 {{current_date}} {{arguments}} {{current_time}}`);
    expect(() => renderScheduledChatTitle('a'.repeat(4081) + '{{chat_id}}', VALUES)).toThrow();
    expect(() => renderScheduledChatTitle('line\nbreak', VALUES)).toThrow();
  });
});

function definition(prompt) {
  return {
    schedule: { type: 'once', runAtUtc: '2030-01-01T09:00:00.000Z' },
    target: { type: 'existing-chat', chatId: CHAT_ID, busyBehavior: 'queue' },
    prompt,
  };
}

function newChatDefinition(preambleChoice) {
  return {
    schedule: { type: 'once', runAtUtc: '2030-01-01T09:00:00.000Z' },
    target: {
      type: 'new-chat',
      agentId: 'codex',
      projectPath: '/workspace/project',
      model: 'gpt-5',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettingsById: {
        codex: { ownerId: 'codex', schemaVersion: 1, values: {} },
      },
      tags: [],
      ...(preambleChoice === undefined ? {} : { preambleChoice }),
    },
    prompt: 'Review the project',
  };
}

describe('scheduled new-chat preamble choices', () => {
  it('preserves exact project paths and rejects blank paths', () => {
    const value = newChatDefinition({ mode: 'defaults' });
    for (const projectPath of ['/workspace/project ', ' /workspace/project', '/workspace/project']) {
      value.target.projectPath = projectPath;
      expect(normalizeScheduledPromptDefinitionInput(value)?.target.projectPath).toBe(projectPath);
      expect(normalizeScheduledPrompt({
        ...value, id: 'scheduled-path', schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
        createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z',
      })?.target.projectPath).toBe(projectPath);
    }
    for (const projectPath of ['', '   ', null, 123]) {
      value.target.projectPath = projectPath;
      expect(normalizeScheduledPromptDefinitionInput(value)).toBeNull();
    }
  });

  it('preserves defaults and explicit ordered selections, including explicit none', () => {
    for (const preambleChoice of [
      { mode: 'defaults' },
      { mode: 'explicit', orderedPreambleIds: [] },
      { mode: 'explicit', orderedPreambleIds: [PREAMBLE_B, PREAMBLE_A] },
    ]) {
      expect(normalizeScheduledPromptDefinitionInput(newChatDefinition(preambleChoice))?.target)
        .toMatchObject({ preambleChoice });
    }
  });

  it('rejects missing and malformed choices without repairing them', () => {
    const tooMany = Array.from({ length: PREAMBLE_MAX_COUNT + 1 }, (_, index) => (
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    ));
    for (const preambleChoice of [
      undefined,
      { mode: 'defaults', orderedPreambleIds: [] },
      { mode: 'explicit' },
      { mode: 'explicit', orderedPreambleIds: ['invalid'] },
      { mode: 'explicit', orderedPreambleIds: [PREAMBLE_A, PREAMBLE_A] },
      { mode: 'explicit', orderedPreambleIds: tooMany },
      { mode: 'unknown' },
    ]) {
      expect(normalizeScheduledPromptDefinitionInput(newChatDefinition(preambleChoice))).toBeNull();
    }
  });

  it('rejects a preamble choice on an existing-chat target', () => {
    const value = definition('Continue the work');
    value.target.preambleChoice = { mode: 'defaults' };

    expect(normalizeScheduledPromptDefinitionInput(value)).toBeNull();
  });
});

function recurringDefinition(intervalMinutes) {
  return {
    schedule: {
      type: 'recurring',
      firstRunAtUtc: '2030-01-01T09:00:00.000Z',
      intervalMinutes,
      endAtUtc: null,
    },
    target: { type: 'existing-chat', chatId: CHAT_ID, busyBehavior: 'queue' },
    prompt: 'Continue the work',
  };
}

describe('scheduled prompt variables', () => {
  it('renders active chat ID tokens and unescapes escaped tokens', () => {
    expect(
      renderScheduledPrompt(
        `Chat ${SCHEDULED_PROMPT_CHAT_ID_TOKEN}; literal \\${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`,
        VALUES,
      ),
    ).toBe(`Chat ${CHAT_ID}; literal ${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`);
  });

  it('leaves unsupported variables unchanged', () => {
    expect(renderScheduledPrompt('{{arguments}} {{project_path}} {{unknown}}', VALUES)).toBe(
      '{{arguments}} {{project_path}} {{unknown}}',
    );
  });

  it('accepts an output exactly at the limit and rejects a longer rendered output', () => {
    const exact = `${'x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH - CHAT_ID.length)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`;
    const tooLong = `${'x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH - CHAT_ID.length + 1)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`;

    expect(renderScheduledPrompt(exact, VALUES)).toHaveLength(SCHEDULED_PROMPT_MAX_LENGTH);
    expect(scheduledPromptFitsRenderedLimit(exact)).toBe(true);
    expect(scheduledPromptFitsRenderedLimit(tooLong)).toBe(false);
    expect(normalizeScheduledPromptDefinitionInput(definition(exact))).not.toBeNull();
    expect(normalizeScheduledPromptDefinitionInput(definition(tooLong))?.prompt).toBe(tooLong);
  });

  it('preserves source before dispatch expands template variables', () => {
    const source = '  /markdown printf "{{chat_id}}"  \n';
    expect(normalizeScheduledPromptDefinitionInput(definition(source))?.prompt).toBe(source);
    expect(normalizeScheduledPromptDefinitionInput(definition('x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH + 1)))).toBeNull();
  });

  it('does not drop persisted prompts that exceed the rendered limit', () => {
    const prompt = `${'x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH - SCHEDULED_PROMPT_CHAT_ID_TOKEN.length)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`;

    expect(
      normalizeScheduledPrompt({
        id: 'scheduled-a',
        schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
        target: { type: 'existing-chat', chatId: CHAT_ID, busyBehavior: 'queue' },
        prompt,
        createdAt: '2029-01-01T00:00:00.000Z',
        updatedAt: '2029-01-01T00:00:00.000Z',
      }),
    ).not.toBeNull();
  });
});

describe('scheduled prompt recurring intervals', () => {
  it('accepts the inclusive minute interval bounds', () => {
    for (const intervalMinutes of [SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN, 5, 59, 60, 90, 1440, SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX]) {
      expect(normalizeScheduledPromptDefinitionInput(recurringDefinition(intervalMinutes))?.schedule).toMatchObject({
        type: 'recurring',
        intervalMinutes,
      });
    }
  });

  it('rejects invalid minute intervals and the retired day-based field', () => {
    for (const intervalMinutes of [0, 1.5, SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX + 1]) {
      expect(normalizeScheduledPromptDefinitionInput(recurringDefinition(intervalMinutes))).toBeNull();
    }
    for (const field of ['intervalDays', 'intervalHours']) {
      for (const interval of [undefined, 90]) {
        const legacy = recurringDefinition(interval);
        legacy.schedule[field] = 1;
        expect(normalizeScheduledPromptDefinitionInput(legacy)).toBeNull();
      }
    }
  });
});


it('defaults existing records to enabled, retains pauses, and rejects invalid enablement', () => {
  const record = {
    id: 'prompt-enabled', prompt: 'Synthetic prompt',
    schedule: { type: 'once', nextRunAt: '2030-01-01T00:00:00.000Z' },
    target: { type: 'existing-chat', chatId: 'synthetic-chat', busyBehavior: 'skip' },
    createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z',
  };
  expect(normalizeScheduledPrompt(record).enabled).toBe(true);
  expect(normalizeScheduledPrompt({ ...record, enabled: false }).enabled).toBe(false);
  for (const enabled of [null, 'false', 0]) expect(normalizeScheduledPrompt({ ...record, enabled })).toBeNull();
});
