import { describe, expect, it, mock } from 'bun:test';
import { assertAttachmentsSupported } from '../support.ts';

const IMAGE = { data: 'data:image/png;base64,AAAA', name: 'screen.png', mimeType: 'image/png' };

function agents(overrides = {}) {
  return {
    assertExecutorReady: mock(() => undefined),
    modelSupportsImages: mock(() => true),
    supportsImages: mock(() => true),
    supportsFileAttachmentMimeType: mock(() => true),
    ...overrides,
  };
}

describe('attachment support', () => {
  it('decides synchronously from the native integration or the selected endpoint model', () => {
    const native = agents({ supportsImages: mock(() => false) });
    expect(() => assertAttachmentsSupported(native, {
      agentId: 'claude',
      model: 'opus',
      attachments: [IMAGE],
    })).toThrow('Attachments unsupported for agent: claude');
    expect(native.modelSupportsImages).toHaveBeenCalledTimes(1);

    const endpoint = agents({ supportsImages: mock(() => false) });
    expect(assertAttachmentsSupported(endpoint, {
      executorId: 'remote-1',
      agentId: 'claude',
      model: 'endpoint-model',
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint-1',
      attachments: [IMAGE],
    })).toBeUndefined();
    expect(endpoint.assertExecutorReady).toHaveBeenCalledWith('remote-1');
  });

  it('fails closed when endpoint image support cannot be resolved', () => {
    const failing = agents({
      modelSupportsImages: mock(() => {
        throw new Error('endpoint unassigned');
      }),
    });

    expect(() => assertAttachmentsSupported(failing, {
      agentId: 'claude',
      model: 'endpoint-model',
      apiProviderId: 'provider-1',
      modelEndpointId: 'endpoint-1',
      attachments: [IMAGE],
    })).toThrow('Attachments unsupported for agent: claude');
  });

  it('checks a chat against its current selection', () => {
    const capabilities = agents();
    assertAttachmentsSupported(capabilities, {
      executorId: 'local',
      agentId: 'codex',
      model: 'gpt-5.4-nano',
      apiProviderId: null,
      modelEndpointId: null,
      attachments: [IMAGE],
    });

    expect(capabilities.modelSupportsImages).toHaveBeenCalledWith({
      executorId: 'local',
      agentId: 'codex',
      model: 'gpt-5.4-nano',
      apiProviderId: null,
      modelEndpointId: null,
    });
    expect(capabilities.supportsImages).toHaveBeenCalledWith('codex', 'local');
  });

  it('requires a chat model only when attachments are present', () => {
    const capabilities = agents();
    const chat = { agentId: 'claude', model: null };

    expect(assertAttachmentsSupported(capabilities, { ...chat, attachments: [] })).toBeUndefined();
    expect(() => assertAttachmentsSupported(capabilities, { ...chat, attachments: [IMAGE] }))
      .toThrow('The chat has no model to receive attachments');
    expect(capabilities.assertExecutorReady).not.toHaveBeenCalled();
  });
});
