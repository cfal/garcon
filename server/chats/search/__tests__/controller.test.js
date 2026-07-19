import { describe, expect, it, mock } from 'bun:test';
import { TranscriptSearchController } from '../controller.js';

describe('TranscriptSearchController', () => {
  it('retries integration-owned cleanup on startup while search is disabled', async () => {
    const disableAndDelete = mock(async () => {});
    const controller = new TranscriptSearchController({
      integrations: {
        list: () => [{ transcriptSearch: { disableAndDelete } }],
      },
      listChats: () => [],
    });

    await controller.initialize(false);

    expect(disableAndDelete).toHaveBeenCalledWith({
      generation: { epoch: expect.any(String), sequence: 1 },
      signal: expect.any(AbortSignal),
    });
  });
});
