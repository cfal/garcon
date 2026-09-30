import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_TICKET_DISPATCH_PROMPT,
  TICKET_DISPATCH_TICKET_TOKEN,
  formatTicketForDispatch,
  renderTicketDispatchPrompt,
  ticketDispatchPromptError,
} from '../ticket-dispatch.js';
import { GENERATION_PROMPT_TEMPLATE_MAX_LENGTH } from '../generation-prompts.js';
import {
  MODEL_SELECTION_UI_SETTING_KEYS,
  normalizeRemoteSettingsSnapshot,
  normalizeTicketDispatchUiSettings,
} from '../settings.js';

const ticket = {
  id: 'G-7',
  title: 'Preserve failed-save drafts',
  project: '/repo/app',
  description: 'Keep the draft after a failed save.\n\nAdd a regression test.',
};

describe('ticket dispatch prompt contract', () => {
  it('formats the ticket identity, project, and description', () => {
    expect(formatTicketForDispatch(ticket)).toBe(
      'Ticket G-7: Preserve failed-save drafts\nProject: /repo/app\n\nKeep the draft after a failed save.\n\nAdd a regression test.',
    );
  });

  it('omits an empty or unloaded description', () => {
    for (const description of ['', '  \n', null]) {
      expect(formatTicketForDispatch({ ...ticket, description })).toBe(
        'Ticket G-7: Preserve failed-save drafts\nProject: /repo/app',
      );
    }
  });

  it('renders the default template when no custom template is saved', () => {
    for (const template of [undefined, '', '   ']) {
      expect(renderTicketDispatchPrompt(template, ticket)).toBe(
        DEFAULT_TICKET_DISPATCH_PROMPT.replace(TICKET_DISPATCH_TICKET_TOKEN, formatTicketForDispatch(ticket)),
      );
    }
  });

  it('replaces every ticket token in a custom template', () => {
    expect(renderTicketDispatchPrompt('Fix {{ticket}}\n---\n{{ticket}}', { ...ticket, description: '' })).toBe(
      'Fix Ticket G-7: Preserve failed-save drafts\nProject: /repo/app\n---\nTicket G-7: Preserve failed-save drafts\nProject: /repo/app',
    );
  });

  it('falls back to the default template when a stored template is invalid', () => {
    expect(renderTicketDispatchPrompt('No token here', ticket)).toBe(
      renderTicketDispatchPrompt(undefined, ticket),
    );
  });

  it('validates custom templates', () => {
    expect(ticketDispatchPromptError('')).toBeNull();
    expect(ticketDispatchPromptError('Work on {{ticket}}')).toBeNull();
    expect(ticketDispatchPromptError('Work on it')).toBe('missing-ticket-token');
    expect(ticketDispatchPromptError(`{{ticket}}${'x'.repeat(GENERATION_PROMPT_TEMPLATE_MAX_LENGTH)}`)).toBe('too-long');
  });
});

describe('ticket dispatch settings contract', () => {
  it('shares executor and provider reference guards with generation settings', () => {
    expect(MODEL_SELECTION_UI_SETTING_KEYS).toContain('ticketDispatch');
    expect(MODEL_SELECTION_UI_SETTING_KEYS).toContain('promptRefinement');
  });

  it('keeps the selection and prompt and drops unrelated fields', () => {
    expect(normalizeTicketDispatchUiSettings({
      executorId: null,
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'high',
      customPrompt: 'Do {{ticket}}',
      enabled: true,
    })).toEqual({
      executorId: null,
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'high',
      customPrompt: 'Do {{ticket}}',
    });
    expect(normalizeTicketDispatchUiSettings('codex')).toBeUndefined();
  });

  it('round-trips through the remote settings snapshot', () => {
    const snapshot = normalizeRemoteSettingsSnapshot({
      version: 1,
      features: { transcriptSearch: { enabled: false } },
      ui: { ticketDispatch: { agentId: 'claude', model: 'opus', customPrompt: '{{ticket}}' } },
      uiEffective: {},
      paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
      pinnedChatIds: [],
      recentAgentSettings: [],
      executionDefaults: { global: { permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {} }, byAgent: {} },
      projectBasePath: '/',
      telegram: {
        botTokenAvailable: false,
        botUsername: null,
        botFirstName: null,
        recipientUsername: null,
        recipientDisplayName: null,
        recipientLinked: false,
        pendingLink: false,
        linkUrl: null,
      },
    });
    expect(snapshot?.ui.ticketDispatch).toEqual({ agentId: 'claude', model: 'opus', customPrompt: '{{ticket}}' });
  });
});
