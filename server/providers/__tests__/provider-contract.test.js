import { describe, expect, it } from 'bun:test';
import {
  API_PROVIDER_TEMPLATE_IDS,
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
  endpointSupportsAgent,
  agentsForEndpoint,
  agentsForProtocol,
  isApiProviderTemplateId,
  isEndpointOnlyAgentId,
  isAgentCompatibleWithProtocol,
  isOAuthAgentId,
  isOtherSettingsAgentId,
  isVisibleAgentId,
} from '../../../common/providers.ts';
import { templatesForProtocol } from '../../../common/api-provider-templates.ts';

describe('shared agent/API provider contract', () => {
  it('maps Anthropic-compatible endpoints to Claude Code and Direct Anthropic', () => {
    expect(agentsForProtocol('anthropic-messages')).toEqual([
      'claude',
      DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
    ]);
    expect(isAgentCompatibleWithProtocol('claude', 'anthropic-messages')).toBe(true);
    expect(isAgentCompatibleWithProtocol(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID, 'anthropic-messages')).toBe(true);
    expect(isAgentCompatibleWithProtocol('codex', 'anthropic-messages')).toBe(false);
    expect(isAgentCompatibleWithProtocol(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID, 'anthropic-messages')).toBe(false);
  });

  it('maps OpenAI-compatible endpoints to broad compatible consumers', () => {
    expect(agentsForProtocol('openai-compatible')).toEqual([
      'codex',
      DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
      DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID,
    ]);
    expect(isAgentCompatibleWithProtocol('codex', 'openai-compatible')).toBe(true);
    expect(isAgentCompatibleWithProtocol(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID, 'openai-compatible')).toBe(true);
    expect(isAgentCompatibleWithProtocol(DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID, 'openai-compatible')).toBe(true);
    expect(isAgentCompatibleWithProtocol('claude', 'openai-compatible')).toBe(false);
    expect(isAgentCompatibleWithProtocol(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID, 'openai-compatible')).toBe(false);
  });

  it('maps OpenAI-compatible endpoint capabilities to agents', () => {
    expect(endpointSupportsAgent('codex', {
      protocol: 'openai-compatible',
      capabilities: { chatCompletions: true, responses: true },
    })).toBe(true);
    expect(endpointSupportsAgent(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID, {
      protocol: 'openai-compatible',
      capabilities: { chatCompletions: true, responses: false },
    })).toBe(true);
    expect(endpointSupportsAgent(DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID, {
      protocol: 'openai-compatible',
      capabilities: { chatCompletions: true, responses: false },
    })).toBe(false);
    expect(endpointSupportsAgent(DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID, {
      protocol: 'openai-compatible',
      capabilities: { chatCompletions: false, responses: true },
    })).toBe(true);
    expect(agentsForEndpoint({
      protocol: 'openai-compatible',
      capabilities: { chatCompletions: false, responses: true },
    })).toEqual(['codex', DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID]);
  });

  it('does not treat API provider ids as visible agent ids', () => {
    expect(isVisibleAgentId('claude')).toBe(true);
    expect(isVisibleAgentId(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isVisibleAgentId(DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isVisibleAgentId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isVisibleAgentId('cursor')).toBe(true);
    expect(isVisibleAgentId('pi')).toBe(true);
    expect(isVisibleAgentId('zai')).toBe(false);
    expect(isVisibleAgentId('openrouter')).toBe(false);
    expect(isVisibleAgentId('ollama')).toBe(false);
    expect(isVisibleAgentId('alibaba-cloud')).toBe(false);
    expect(isVisibleAgentId('fireworks')).toBe(false);
    expect(isVisibleAgentId('gemini')).toBe(false);
    expect(isVisibleAgentId('together')).toBe(false);
  });

  it('keeps settings auth rows narrower than visible agents', () => {
    expect(isOAuthAgentId('claude')).toBe(true);
    expect(isOAuthAgentId('codex')).toBe(true);
    expect(isOAuthAgentId(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOAuthAgentId(DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOAuthAgentId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOtherSettingsAgentId('opencode')).toBe(true);
    expect(isOtherSettingsAgentId('amp')).toBe(true);
    expect(isOtherSettingsAgentId('cursor')).toBe(true);
    expect(isOtherSettingsAgentId('factory')).toBe(true);
    expect(isOtherSettingsAgentId('pi')).toBe(true);
    expect(isOtherSettingsAgentId(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOtherSettingsAgentId(DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOtherSettingsAgentId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(false);
  });

  it('identifies endpoint-only direct agents', () => {
    expect(isEndpointOnlyAgentId(DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isEndpointOnlyAgentId(DIRECT_OPENAI_RESPONSES_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isEndpointOnlyAgentId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isEndpointOnlyAgentId('claude')).toBe(false);
    expect(isEndpointOnlyAgentId('pi')).toBe(false);
  });

  it('returns protocol-specific add-provider templates', () => {
    expect(API_PROVIDER_TEMPLATE_IDS.every(isApiProviderTemplateId)).toBe(true);
    expect(isApiProviderTemplateId('missing-provider')).toBe(false);
    expect(templatesForProtocol('anthropic-messages').map((template) => template.id)).toEqual([
      'alibaba-cloud',
      'fireworks',
      'ollama',
      'zai',
      'custom',
    ]);
    expect(templatesForProtocol('openai-compatible').map((template) => template.id)).toEqual([
      'alibaba-cloud',
      'fireworks',
      'gemini',
      'ollama',
      'openrouter',
      'together',
      'zai',
      'custom',
    ]);
  });

  it('prefills OpenAI endpoint capabilities from protocol-specific templates', () => {
    for (const template of templatesForProtocol('anthropic-messages')) {
      expect(template.capabilities).toBeUndefined();
    }
    for (const template of templatesForProtocol('openai-compatible')) {
      expect(template.capabilities?.chatCompletions || template.capabilities?.responses).toBe(true);
    }
  });

  it('prefills Responses only for OpenAI-compatible presets with Responses support', () => {
    const openAiTemplates = templatesForProtocol('openai-compatible');
    const responsesCapable = openAiTemplates
      .filter((template) => template.capabilities?.responses)
      .map((template) => template.id);
    const directOnly = openAiTemplates
      .filter((template) => !template.capabilities?.responses)
      .map((template) => template.id);

    expect(responsesCapable).toEqual(['alibaba-cloud', 'fireworks', 'ollama', 'openrouter']);
    expect(directOnly).toEqual(['gemini', 'together', 'zai', 'custom']);
  });
});
