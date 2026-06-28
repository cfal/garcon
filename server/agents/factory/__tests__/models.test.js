import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { getFactoryModelCatalog } from '../factory-models.js';

function createHelpProc(stdoutText, exitCode = 0) {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stdoutText));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  };
}

describe('factory model discovery', () => {
  let originalSpawn;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it('parses hosted and custom models from Droid help without airgap', async () => {
    spawnMock.mockReturnValueOnce(createHelpProc(`
Usage: droid exec [options] [prompt]

Available Models:
  claude-opus-4-6              Claude Opus 4.6 (default)
  gpt-5.4                      GPT-5.4

Custom Models:
  custom:GLM-5.2-[Alibaba]-0   GLM 5.2 [Alibaba]

Model details:
  - Claude Opus 4.6: supports reasoning: Yes; supported: [off, low, medium, high, max]; default: high
  - GPT-5.4: supports reasoning: Yes; supported: [off, low, medium, high, xhigh]; default: high
`));

    const catalog = await getFactoryModelCatalog(true);

    expect(catalog.defaultModel).toBe('claude-opus-4-6');
    expect(catalog.options).toEqual([
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportsImages: true },
      { value: 'gpt-5.4', label: 'GPT-5.4', supportsImages: true },
      { value: 'custom:GLM-5.2-[Alibaba]-0', label: 'GLM 5.2 [Alibaba]', supportsImages: true },
    ]);
    expect(catalog.metadata['gpt-5.4'].reasoningEfforts).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    expect(spawnMock.mock.calls[0][1].env.FACTORY_AIRGAP_ENABLED).toBeUndefined();
    expect(spawnMock.mock.calls[0][1].env).toMatchObject({
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });
  });

  it('falls back to static models when Droid help fails', async () => {
    spawnMock.mockReturnValueOnce(createHelpProc('nope', 1));

    const catalog = await getFactoryModelCatalog(true);

    expect(catalog.options.length).toBeGreaterThan(0);
    expect(catalog.options.find((entry) => entry.value === catalog.defaultModel)).toBeTruthy();
    expect(typeof catalog.metadata[catalog.defaultModel]?.supportsImages).toBe('boolean');
  });
});
