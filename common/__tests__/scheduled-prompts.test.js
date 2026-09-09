import { describe, expect, it } from 'bun:test';
import {
  SCHEDULED_PROMPT_CHAT_ID_TOKEN,
  SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX,
  SCHEDULED_PROMPT_INTERVAL_MINUTES_MIN,
  SCHEDULED_PROMPT_MAX_LENGTH,
  normalizeScheduledPrompt,
  normalizeScheduledPromptDefinitionInput,
  renderScheduledPrompt,
  scheduledPromptFitsRenderedLimit,
} from '../scheduled-prompts.js';
import { PREAMBLE_MAX_COUNT } from '../preambles.js';

const CHAT_ID = '1783725900000000';
const PREAMBLE_A = '00000000-0000-4000-8000-000000000001';
const PREAMBLE_B = '00000000-0000-4000-8000-000000000002';

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
        CHAT_ID,
      ),
    ).toBe(`Chat ${CHAT_ID}; literal ${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`);
  });

  it('leaves unsupported variables unchanged', () => {
    expect(renderScheduledPrompt('{{arguments}} {{project_path}} {{unknown}}', CHAT_ID)).toBe(
      '{{arguments}} {{project_path}} {{unknown}}',
    );
  });

  it('accepts an output exactly at the limit and rejects a longer rendered output', () => {
    const exact = `${'x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH - CHAT_ID.length)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`;
    const tooLong = `${'x'.repeat(SCHEDULED_PROMPT_MAX_LENGTH - CHAT_ID.length + 1)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}`;

    expect(renderScheduledPrompt(exact, CHAT_ID)).toHaveLength(SCHEDULED_PROMPT_MAX_LENGTH);
    expect(scheduledPromptFitsRenderedLimit(exact)).toBe(true);
    expect(scheduledPromptFitsRenderedLimit(tooLong)).toBe(false);
    expect(normalizeScheduledPromptDefinitionInput(definition(exact))).not.toBeNull();
    expect(normalizeScheduledPromptDefinitionInput(definition(tooLong))).toBeNull();
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
