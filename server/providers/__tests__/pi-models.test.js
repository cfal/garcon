import { afterEach, describe, expect, it, mock } from 'bun:test';

import { PI_MODELS } from '../../../common/models.js';
import { clearPiModelCacheForTests, getPiModels, parsePiListModelsOutput } from '../pi-models.js';

const originalSpawn = Bun.spawn;

function textStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  Bun.spawn = originalSpawn;
  clearPiModelCacheForTests();
});

describe('Pi model discovery', () => {
  it('parses pi --list-models table rows', () => {
    const models = parsePiListModelsOutput(`
provider   model                  context   max-out   thinking   images
anthropic  claude-opus-4-6        200K      32K       yes        yes
openai     gpt-5.4                400K      128K      yes        no
`);

    expect(models).toEqual([
      { value: 'anthropic/claude-opus-4-6', label: 'anthropic/claude-opus-4-6', supportsImages: true },
      { value: 'openai/gpt-5.4', label: 'openai/gpt-5.4', supportsImages: false },
    ]);
  });

  it('ignores non-table output', () => {
    expect(parsePiListModelsOutput('No models are configured. Run pi and configure a provider.')).toEqual([]);
  });

  it('prepends the default fallback to dynamically discovered models', async () => {
    Bun.spawn = mock(() => ({
      stdout: textStream(`
provider   model            context   max-out   thinking   images
openai     gpt-5.4          400K      128K      yes        yes
`),
      stderr: textStream(''),
      exited: Promise.resolve(0),
    }));

    await expect(getPiModels()).resolves.toEqual([
      ...PI_MODELS.OPTIONS,
      { value: 'openai/gpt-5.4', label: 'openai/gpt-5.4', supportsImages: true },
    ]);
  });

  it('falls back to Pi Default when model discovery fails', async () => {
    Bun.spawn = mock(() => ({
      stdout: textStream(''),
      stderr: textStream('not logged in'),
      exited: Promise.resolve(1),
    }));

    await expect(getPiModels()).resolves.toEqual(PI_MODELS.OPTIONS);
  });
});
