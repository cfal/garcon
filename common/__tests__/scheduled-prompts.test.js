import { describe, expect, it } from 'bun:test';
import {
  SCHEDULED_PROMPT_CHAT_ID_TOKEN,
  SCHEDULED_PROMPT_MAX_LENGTH,
  normalizeScheduledPrompt,
  normalizeScheduledPromptDefinitionInput,
  renderScheduledPrompt,
  scheduledPromptFitsRenderedLimit,
} from '../scheduled-prompts.js';

const CHAT_ID = '1783725900000000';

function definition(prompt) {
  return {
    schedule: { type: 'once', runAtUtc: '2030-01-01T09:00:00.000Z' },
    target: { type: 'existing-chat', chatId: CHAT_ID, busyBehavior: 'queue' },
    prompt,
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
