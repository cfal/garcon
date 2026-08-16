import { describe, expect, it, mock } from 'bun:test';
import { GarconOperationIdentityPlugin } from '../operation-identity-plugin.js';

function pluginFixture(prompt = mock(() => Promise.resolve({ data: {} }))) {
  const client = { session: { prompt } };
  return GarconOperationIdentityPlugin({ client, directory: '/repo' }).then((hooks) => ({
    hooks,
    prompt,
  }));
}

async function captureOperation(hooks, sessionID = 'session-1', operationPartId = 'part-operation') {
  await hooks['chat.message'](
    { sessionID },
    {
      message: {},
      parts: [{
        type: 'text',
        metadata: { garcon_operation_part_id: operationPartId },
      }],
    },
  );
}

function compactionInput(overrides = {}) {
  return {
    sessionID: 'session-1',
    overflow: false,
    message: {
      agent: 'build',
      model: { providerID: 'scripted', modelID: 'model' },
    },
    ...overrides,
  };
}

describe('GarconOperationIdentityPlugin', () => {
  it('replaces an automatic continuation with an operation-qualified provider message', async () => {
    const { hooks, prompt } = await pluginFixture();
    await captureOperation(hooks);
    const output = { enabled: true };

    await hooks['experimental.compaction.autocontinue'](compactionInput(), output);

    expect(output.enabled).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toEqual({
      path: { id: 'session-1' },
      query: { directory: '/repo' },
      body: {
        agent: 'build',
        model: { providerID: 'scripted', modelID: 'model' },
        noReply: true,
        parts: [{
          type: 'text',
          text: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
          synthetic: true,
          metadata: { garcon_operation_part_id: 'part-operation' },
        }],
      },
    });
  });

  it('preserves the provider overflow continuation text', async () => {
    const { hooks, prompt } = await pluginFixture();
    await captureOperation(hooks);
    const output = { enabled: true };

    await hooks['experimental.compaction.autocontinue'](
      compactionInput({ overflow: true }),
      output,
    );

    expect(prompt.mock.calls[0][0].body.parts[0].text).toBe(
      'The previous request exceeded the provider\'s size limit due to large media attachments. '
      + 'The conversation was compacted and media files were removed from context. '
      + 'If the user was asking about attached images or files, explain that the attachments '
      + 'were too large to process and suggest they try again with smaller or fewer files.\n\n'
      + 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
    );
  });

  it('does not invent an operation identity and retires captured identities at idle', async () => {
    const { hooks, prompt } = await pluginFixture();
    const outputBeforeCapture = { enabled: true };
    await hooks['experimental.compaction.autocontinue'](compactionInput(), outputBeforeCapture);
    expect(outputBeforeCapture.enabled).toBe(true);

    await captureOperation(hooks);
    await hooks.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'idle' } },
      },
    });
    const outputAfterIdle = { enabled: true };
    await hooks['experimental.compaction.autocontinue'](compactionInput(), outputAfterIdle);

    expect(outputAfterIdle.enabled).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('keeps OpenCode automatic continuation enabled when identity publication fails', async () => {
    const { hooks } = await pluginFixture(mock(() => Promise.resolve({ error: { name: 'failed' } })));
    await captureOperation(hooks);
    const output = { enabled: true };

    await expect(
      hooks['experimental.compaction.autocontinue'](compactionInput(), output),
    ).rejects.toThrow('operation-qualified compaction continuation');
    expect(output.enabled).toBe(true);
  });
});
