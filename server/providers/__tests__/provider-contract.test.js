import { describe, expect, it } from 'bun:test';
import {
  harnessesForProtocol,
  isHarnessCompatibleWithProtocol,
  isOAuthHarnessId,
  isOtherSettingsHarnessId,
  isVisibleHarnessId,
} from '../../../common/providers.ts';
import { templatesForProtocol } from '../../../common/api-provider-templates.ts';

describe('shared harness/API provider contract', () => {
  it('maps Anthropic-compatible endpoints only to Claude Code', () => {
    expect(harnessesForProtocol('anthropic-messages')).toEqual(['claude']);
    expect(isHarnessCompatibleWithProtocol('claude', 'anthropic-messages')).toBe(true);
    expect(isHarnessCompatibleWithProtocol('codex', 'anthropic-messages')).toBe(false);
    expect(isHarnessCompatibleWithProtocol('direct-openai-compatible', 'anthropic-messages')).toBe(false);
  });

  it('maps OpenAI-compatible endpoints only to Codex and Direct Chat', () => {
    expect(harnessesForProtocol('openai-chat-completions')).toEqual([
      'codex',
      'direct-openai-compatible',
    ]);
    expect(isHarnessCompatibleWithProtocol('codex', 'openai-chat-completions')).toBe(true);
    expect(isHarnessCompatibleWithProtocol('direct-openai-compatible', 'openai-chat-completions')).toBe(true);
    expect(isHarnessCompatibleWithProtocol('claude', 'openai-chat-completions')).toBe(false);
  });

  it('does not treat API provider ids as visible harness ids', () => {
    expect(isVisibleHarnessId('claude')).toBe(true);
    expect(isVisibleHarnessId('direct-openai-compatible')).toBe(true);
    expect(isVisibleHarnessId('zai')).toBe(false);
    expect(isVisibleHarnessId('openrouter')).toBe(false);
    expect(isVisibleHarnessId('ollama')).toBe(false);
  });

  it('keeps settings auth rows narrower than visible harnesses', () => {
    expect(isOAuthHarnessId('claude')).toBe(true);
    expect(isOAuthHarnessId('codex')).toBe(true);
    expect(isOAuthHarnessId('direct-openai-compatible')).toBe(false);
    expect(isOtherSettingsHarnessId('opencode')).toBe(true);
    expect(isOtherSettingsHarnessId('amp')).toBe(true);
    expect(isOtherSettingsHarnessId('factory')).toBe(true);
    expect(isOtherSettingsHarnessId('direct-openai-compatible')).toBe(false);
  });

  it('returns protocol-specific add-provider templates', () => {
    expect(templatesForProtocol('anthropic-messages').map((template) => template.id)).toEqual([
      'zai',
      'ollama',
      'custom',
    ]);
    expect(templatesForProtocol('openai-chat-completions').map((template) => template.id)).toEqual([
      'openrouter',
      'zai',
      'ollama',
      'custom',
    ]);
  });
});
