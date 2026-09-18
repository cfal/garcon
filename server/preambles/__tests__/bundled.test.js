import { describe, expect, it } from 'bun:test';
import { AssistantMessage } from '../../../common/chat-types.js';
import { extractGarconCommands } from '../../../common/garcon-commands.js';
import {
  normalizePreamble,
  normalizePreambleDefinitionInput,
  renderPreambleContent,
} from '../../../common/preambles.js';
import { TICKET_ACTIONS } from '../../../common/ticket-commands.js';
import { BUNDLED_PREAMBLES } from '../bundled.ts';
import { preambleCatalogCompositionViolation } from '../catalog-budget.ts';

const AT = '2026-09-15T00:00:00.000Z';
const CHAT_ID = '1000000000000001';

function bundled(title) {
  const definition = BUNDLED_PREAMBLES.find((entry) => entry.title === title);
  if (!definition) throw new Error(`Missing bundled preamble: ${title}`);
  return definition;
}

function renderedExamples(title) {
  const rendered = renderPreambleContent(bundled(title).content, CHAT_ID);
  return [...rendered.matchAll(/```text\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
}

function exampleCommands(title) {
  return renderedExamples(title).flatMap((example) => {
    const transformed = extractGarconCommands(new AssistantMessage(AT, example));
    expect(transformed?.issues).toEqual([]);
    expect(transformed?.message).toBeNull();
    return transformed?.commands ?? [];
  });
}

describe('bundled preambles', () => {
  it('defines six valid, unique, disabled global entries within the shared budget', () => {
    expect(BUNDLED_PREAMBLES.map((entry) => entry.title)).toEqual([
      'Garcon: Chat identity',
      'Garcon: Inter-chat messages',
      'Garcon: Delegated agents',
      'Garcon: Scheduled prompts',
      'Garcon: Tickets',
      'Garcon: Captain',
    ]);
    expect(new Set(BUNDLED_PREAMBLES.map((entry) => entry.id)).size).toBe(
      BUNDLED_PREAMBLES.length,
    );

    const materialized = BUNDLED_PREAMBLES.map((entry) => {
      const { id: _id, ...definition } = entry;
      expect(normalizePreambleDefinitionInput(definition)).toEqual({
        enabled: false,
        title: entry.title,
        content: entry.content,
        scope: { type: 'global' },
        agentIds: [],
        tagFilter: { mode: 'any', tags: [] },
      });
      expect(entry.enabled).toBe(false);
      const normalized = normalizePreamble({ ...entry, createdAt: AT, updatedAt: AT });
      if (!normalized) throw new Error(`Invalid bundled preamble: ${entry.title}`);
      return normalized;
    });

    expect(preambleCatalogCompositionViolation(
      materialized.map((entry) => ({ ...entry, enabled: true })),
    )).toBeNull();
  });

  it('teaches chat identity and message commands accepted by the current grammar', () => {
    expect(exampleCommands('Garcon: Chat identity')).toEqual([{ type: 'get-chat-id' }]);

    const messages = exampleCommands('Garcon: Inter-chat messages');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'send-message',
      recipients: ['1000000000000001', '1000000000000002'],
      hideSender: false,
      body: 'Build status requested.',
    });
  });

  it('teaches inherited delegation, resume, stop, and removal commands', () => {
    const commands = exampleCommands('Garcon: Delegated agents');
    expect(commands.map((command) => command.type)).toEqual([
      'start-agent',
      'resume-agent',
      'stop-agent',
      'stop-agent',
    ]);
    expect(commands[0]).toMatchObject({
      type: 'start-agent',
      agentId: null,
      providerId: null,
      model: null,
      reasoningEffort: null,
    });
    expect(commands[3]).toMatchObject({ type: 'stop-agent', remove: true });
  });

  it('preserves the literal chat-ID token while teaching valid schedules', () => {
    const definition = bundled('Garcon: Scheduled prompts');
    expect(definition.content.match(/\\\{\{chat_id\}\}/gu)).toHaveLength(2);

    const rendered = renderPreambleContent(definition.content, CHAT_ID);
    expect(rendered).not.toContain(`for ${CHAT_ID}`);
    expect(rendered.match(/\{\{chat_id\}\}/gu)).toHaveLength(2);

    const commands = exampleCommands('Garcon: Scheduled prompts');
    expect(commands.map((command) => command.type)).toEqual([
      'schedule',
      'schedule',
      'schedule',
    ]);
    expect(commands[2]).toMatchObject({
      type: 'schedule',
      intervalMinutes: 1_440,
      body: 'Send the daily status for {{chat_id}}.',
    });
  });

  it('teaches every ticket command accepted by the current grammar', () => {
    const commands = exampleCommands('Garcon: Tickets');
    const actions = commands.map((command) => command.payload?.action).filter(Boolean);
    expect(actions.sort()).toEqual([...TICKET_ACTIONS].sort());
  });
});
