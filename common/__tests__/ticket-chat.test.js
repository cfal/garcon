import { describe, expect, it } from 'bun:test';
import { DEFAULT_TICKET_CHAT_PROMPT, TICKET_CHAT_PROMPT_MAX_LENGTH, renderTicketChatPrompt, ticketChatPromptError } from '../ticket-chat.js';
import { GENERATION_PROMPT_TEMPLATE_MAX_LENGTH } from '../generation-prompts.js';
import { normalizeRemoteSettingsSnapshot, normalizeTicketChatUiSettings } from '../settings.js';

const ticket = { id: 'G-7', title: 'Synthetic title', project: 'Project label', description: 'First line\n\nSecond line' };

describe('ticket chat prompt', () => {
  it('expands independently ordered and repeated variables', () => {
    expect(renderTicketChatPrompt('{{ticket_description}}\n{{ticket_id}} / {{ticket_title}} / {{ticket_project}} / {{ticket_id}}', ticket))
      .toBe('First line\n\nSecond line\nG-7 / Synthetic title / Project label / G-7');
  });

  it('requires only the ID, allowing the agent to look up omitted fields', () => {
    expect(renderTicketChatPrompt('Read {{ticket_id}}', ticket)).toBe('Read G-7');
  });

  it('does not interpret replacement syntax or variables inside ticket content', () => {
    expect(renderTicketChatPrompt('{{ticket_id}} {{ticket_title}} {{ticket_description}}', {
      ...ticket, title: '{{ticket_description}}', description: '$& $$ {{ticket_id}}',
    })).toBe('G-7 {{ticket_description}} $& $$ {{ticket_id}}');
  });

  it('preserves multiline content and accepts empty descriptions', () => {
    expect(renderTicketChatPrompt('{{ticket_id}}\n{{ticket_description}}', ticket)).toBe('G-7\nFirst line\n\nSecond line');
    expect(renderTicketChatPrompt('{{ticket_id}}\n{{ticket_description}}', { ...ticket, description: '' })).toBe('G-7');
  });

  it('uses the default for missing or blank templates', () => {
    for (const template of [undefined, '', '  \n']) {
      expect(renderTicketChatPrompt(template, ticket)).toBe(renderTicketChatPrompt(DEFAULT_TICKET_CHAT_PROMPT, ticket));
    }
    expect(renderTicketChatPrompt(undefined, ticket)).toContain('Project label: Project label');
  });

  it('rejects missing IDs, unknown variables, and oversized templates', () => {
    expect(ticketChatPromptError('')).toBeNull();
    expect(ticketChatPromptError('{{ticket_title}}')).toBe('missing-ticket-id');
    expect(ticketChatPromptError('{{ticket_id}} {{ticket}}')).toBe('unknown-variable');
    expect(ticketChatPromptError('{{ticket_id}} {{ticket_descripton}}')).toBe('unknown-variable');
    expect(ticketChatPromptError('{{ticket_id}}'.padEnd(GENERATION_PROMPT_TEMPLATE_MAX_LENGTH, 'x'))).toBeNull();
    expect(ticketChatPromptError('{{ticket_id}}'.padEnd(GENERATION_PROMPT_TEMPLATE_MAX_LENGTH + 1, 'x'))).toBe('too-long');
    expect(() => renderTicketChatPrompt('Invalid stored template', ticket)).toThrow('template is invalid');
  });

  it('bounds expansion before allocating repeated descriptions', () => {
    const large = { ...ticket, description: 'x'.repeat(48 * 1024) };
    const template = '{{ticket_id}}' + '{{ticket_description}}'.repeat(1000);
    expect(ticketChatPromptError(template)).toBeNull();
    expect(() => renderTicketChatPrompt(template, large)).toThrow('exceeds 256000 characters');
    expect(renderTicketChatPrompt('{{ticket_id}}{{ticket_description}}', {
      ...ticket, description: 'x'.repeat(TICKET_CHAT_PROMPT_MAX_LENGTH - ticket.id.length),
    })).toHaveLength(TICKET_CHAT_PROMPT_MAX_LENGTH);
    expect(() => renderTicketChatPrompt('{{ticket_id}}{{ticket_description}}', {
      ...ticket, description: 'x'.repeat(TICKET_CHAT_PROMPT_MAX_LENGTH - ticket.id.length + 1),
    })).toThrow('exceeds');
  });
});

describe('ticket chat settings', () => {
  it('stores only the prompt, with no execution selection', () => {
    expect(normalizeTicketChatUiSettings({ customPrompt: '{{ticket_id}}', executorId: 'remote', agentId: 'codex', model: 'model' }))
      .toEqual({ customPrompt: '{{ticket_id}}' });
    expect(normalizeTicketChatUiSettings({ model: 'model' })).toBeUndefined();
    expect(normalizeTicketChatUiSettings('invalid')).toBeUndefined();
    expect(normalizeTicketChatUiSettings({ customPrompt: '' })).toEqual({ customPrompt: '' });
  });

  it('round-trips through remote settings', () => {
    const snapshot = normalizeRemoteSettingsSnapshot({
      version: 1,
      features: { transcriptSearch: { enabled: false } },
      ui: { ticketChat: { customPrompt: '{{ticket_id}}' } },
      uiEffective: {},
      paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
      pinnedChatIds: [], recentAgentSettings: [],
      executionDefaults: { global: { permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {} }, byAgent: {} },
      projectBasePath: '/',
      telegram: {
        botTokenAvailable: false, botUsername: null, botFirstName: null, recipientUsername: null,
        recipientDisplayName: null, recipientLinked: false, pendingLink: false, linkUrl: null,
      },
    });
    expect(snapshot.ui.ticketChat).toEqual({ customPrompt: '{{ticket_id}}' });
  });
});
