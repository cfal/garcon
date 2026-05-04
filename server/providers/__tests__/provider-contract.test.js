import { describe, expect, it } from 'bun:test';
import {
  API_PROVIDER_TEMPLATE_IDS,
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_COMPATIBLE_HARNESS_ID,
  harnessesForProtocol,
  isApiProviderTemplateId,
  isEndpointOnlyHarnessId,
  isHarnessCompatibleWithProtocol,
  isOAuthHarnessId,
  isOtherSettingsHarnessId,
  isVisibleHarnessId,
} from '../../../common/providers.ts';
import { templatesForProtocol } from '../../../common/api-provider-templates.ts';

describe('shared harness/API provider contract', () => {
  it('maps Anthropic-compatible endpoints to Claude Code and Direct Anthropic', () => {
    expect(harnessesForProtocol('anthropic-messages')).toEqual([
      'claude',
      DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
    ]);
    expect(isHarnessCompatibleWithProtocol('claude', 'anthropic-messages')).toBe(true);
    expect(isHarnessCompatibleWithProtocol(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID, 'anthropic-messages')).toBe(true);
    expect(isHarnessCompatibleWithProtocol('codex', 'anthropic-messages')).toBe(false);
    expect(isHarnessCompatibleWithProtocol(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID, 'anthropic-messages')).toBe(false);
  });

  it('maps OpenAI-compatible endpoints only to Codex and Direct Chat', () => {
    expect(harnessesForProtocol('openai-chat-completions')).toEqual([
      'codex',
      DIRECT_OPENAI_COMPATIBLE_HARNESS_ID,
    ]);
    expect(isHarnessCompatibleWithProtocol('codex', 'openai-chat-completions')).toBe(true);
    expect(isHarnessCompatibleWithProtocol(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID, 'openai-chat-completions')).toBe(true);
    expect(isHarnessCompatibleWithProtocol('claude', 'openai-chat-completions')).toBe(false);
    expect(isHarnessCompatibleWithProtocol(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID, 'openai-chat-completions')).toBe(false);
  });

  it('does not treat API provider ids as visible harness ids', () => {
    expect(isVisibleHarnessId('claude')).toBe(true);
    expect(isVisibleHarnessId(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isVisibleHarnessId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isVisibleHarnessId('zai')).toBe(false);
    expect(isVisibleHarnessId('openrouter')).toBe(false);
    expect(isVisibleHarnessId('ollama')).toBe(false);
    expect(isVisibleHarnessId('alibaba-cloud')).toBe(false);
    expect(isVisibleHarnessId('fireworks')).toBe(false);
    expect(isVisibleHarnessId('gemini')).toBe(false);
    expect(isVisibleHarnessId('together')).toBe(false);
  });

  it('keeps settings auth rows narrower than visible harnesses', () => {
    expect(isOAuthHarnessId('claude')).toBe(true);
    expect(isOAuthHarnessId('codex')).toBe(true);
    expect(isOAuthHarnessId(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOAuthHarnessId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOtherSettingsHarnessId('opencode')).toBe(true);
    expect(isOtherSettingsHarnessId('amp')).toBe(true);
    expect(isOtherSettingsHarnessId('factory')).toBe(true);
    expect(isOtherSettingsHarnessId(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID)).toBe(false);
    expect(isOtherSettingsHarnessId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(false);
  });

  it('identifies endpoint-only direct harnesses', () => {
    expect(isEndpointOnlyHarnessId(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isEndpointOnlyHarnessId(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID)).toBe(true);
    expect(isEndpointOnlyHarnessId('claude')).toBe(false);
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
    expect(templatesForProtocol('openai-chat-completions').map((template) => template.id)).toEqual([
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

  it('prefills direct exposure targets from protocol-specific templates', () => {
    for (const template of templatesForProtocol('anthropic-messages')) {
      expect(template.exposeTo).toContain(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID);
      expect(template.exposeTo).not.toContain(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID);
    }
    for (const template of templatesForProtocol('openai-chat-completions')) {
      expect(template.exposeTo).toContain(DIRECT_OPENAI_COMPATIBLE_HARNESS_ID);
      expect(template.exposeTo).not.toContain(DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID);
    }
  });
});
