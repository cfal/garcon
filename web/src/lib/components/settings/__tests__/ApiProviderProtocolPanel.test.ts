import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ApiProviderProtocolPanelTestHarness from './ApiProviderProtocolPanelTestHarness.svelte';

describe('ApiProviderProtocolPanel', () => {
  it('shows protocol-specific Anthropic add-provider templates', async () => {
    render(ApiProviderProtocolPanelTestHarness, {
      protocol: 'anthropic-messages',
      title: 'Anthropic Providers',
      description: 'Use Anthropic Messages-compatible endpoints with Claude Code and Direct Chat.',
      addLabel: 'Add Anthropic-compatible provider'
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Add Anthropic-compatible provider' }));

    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Add Alibaba Cloud',
      'Add Fireworks.ai',
      'Add Ollama',
      'Add Z.AI',
      'Add custom provider..'
    ]);
    expect(screen.queryByRole('menuitem', { name: 'Add OpenRouter' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Add Together.ai' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Add Gemini' })).toBeNull();
  });

  it('shows protocol-specific OpenAI add-provider templates', async () => {
    render(ApiProviderProtocolPanelTestHarness, {
      protocol: 'openai-compatible',
      title: 'OpenAI Providers',
      description: 'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.',
      addLabel: 'Add OpenAI-compatible provider'
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Add OpenAI-compatible provider' }));

    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Add Alibaba Cloud',
      'Add Fireworks.ai',
      'Add Gemini',
      'Add Ollama',
      'Add OpenRouter',
      'Add Together.ai',
      'Add Z.AI',
      'Add custom provider..'
    ]);
  });

  it('opens OpenAI providers with API capability switches instead of harness exposure toggles', async () => {
    render(ApiProviderProtocolPanelTestHarness, {
      protocol: 'openai-compatible',
      title: 'OpenAI Providers',
      description: 'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.',
      addLabel: 'Add OpenAI-compatible provider'
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Add OpenAI-compatible provider' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Add custom provider..' }));

    const chatCompletions = await screen.findByRole('switch', { name: 'Supports Chat Completions API' });
    const responses = screen.getByRole('switch', { name: 'Supports Responses API' });
    expect(chatCompletions.getAttribute('aria-checked')).toBe('true');
    expect(responses.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText('Use with Codex')).toBeNull();
    expect(screen.queryByText('Use with Direct (Chat Completions)')).toBeNull();
    expect(screen.queryByText('Use with Direct (Responses)')).toBeNull();
  });

  it('opens Anthropic providers without per-harness exposure switches', async () => {
    render(ApiProviderProtocolPanelTestHarness, {
      protocol: 'anthropic-messages',
      title: 'Anthropic Providers',
      description: 'Use Anthropic Messages-compatible endpoints with Claude Code and Direct Chat.',
      addLabel: 'Add Anthropic-compatible provider'
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Add Anthropic-compatible provider' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Add custom provider..' }));

    expect(await screen.findByText('Adds an Anthropic Messages endpoint for Claude Code and Direct.')).toBeTruthy();
    expect(screen.queryByText('Use with Claude Code')).toBeNull();
    expect(screen.queryByText('Use with Direct (Anthropic)')).toBeNull();
  });

  it('renders saved provider rows without built-in or disabled badges', () => {
    render(ApiProviderProtocolPanelTestHarness, {
      protocol: 'openai-compatible',
      title: 'OpenAI Providers',
      description: 'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.',
      addLabel: 'Add OpenAI-compatible provider',
      apiProviderCatalog: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          templateId: 'openrouter',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          endpoints: [
            {
              id: 'openrouter_openai',
              protocol: 'openai-compatible',
              baseUrl: 'https://openrouter.ai/api/v1',
              capabilities: { chatCompletions: true, responses: true },
              defaultModel: 'openai/gpt-5.4',
              models: [{ value: 'openai/gpt-5.4', label: 'GPT-5.4' }],
              supportsImages: true,
              hasApiKey: true,
              modelDiscovery: 'openrouter-models'
            }
          ]
        }
      ]
    });

    expect(screen.getByText('OpenRouter')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy();
    expect(screen.queryByText('builtin')).toBeNull();
    expect(screen.queryByText('Disabled')).toBeNull();
  });
});
