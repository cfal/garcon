import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { getCursorModels, parseCursorModelsOutput } from '../cursor/cursor-models.js';

function procWithOutput(stdoutText, exitCode = 0, stderrText = '') {
  const encoder = new TextEncoder();
  const streamFor = (text) => new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

  return {
    stdout: streamFor(stdoutText),
    stderr: streamFor(stderrText),
    exited: Promise.resolve(exitCode),
  };
}

describe('Cursor model discovery', () => {
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

  it('parses line-oriented Cursor model output', () => {
    expect(parseCursorModelsOutput(`
Models
- gpt-5.3-codex - GPT-5.3
* sonnet-4.5-thinking (Claude 4.5 Sonnet Thinking)
gpt-5.5-extra-high - GPT-5.5 1M Extra High
gpt-5.5-extra-high-fast - GPT-5.5 Extra High Fast
composer-2.5-fast - Composer 2.5 Fast (default)
No models available for this account
gpt-5.3-codex - Duplicate
`)).toEqual([
      { value: 'gpt-5.3-codex', label: 'GPT-5.3', supportsImages: false },
      { value: 'sonnet-4.5-thinking', label: 'Claude 4.5 Sonnet Thinking', supportsImages: false },
      { value: 'gpt-5.5-extra-high', label: 'GPT-5.5 1M Extra High', supportsImages: false },
      { value: 'gpt-5.5-extra-high-fast', label: 'GPT-5.5 Extra High Fast', supportsImages: false },
      { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast (default)', supportsImages: false },
    ]);
  });

  it('returns discovered models when cursor-agent models succeeds', async () => {
    spawnMock.mockReturnValueOnce(procWithOutput('auto - Auto\ncomposer-1 - Composer 1\n'));

    await expect(getCursorModels()).resolves.toEqual([
      { value: 'auto', label: 'Auto', supportsImages: false },
      { value: 'composer-1', label: 'Composer 1', supportsImages: false },
    ]);
    expect(spawnMock.mock.calls[0][0].slice(-1)).toEqual(['models']);
  });

  it('returns no models when Cursor reports none for the account', async () => {
    spawnMock.mockReturnValueOnce(procWithOutput('No models available for this account\n'));

    await expect(getCursorModels()).resolves.toEqual([]);
  });
});
