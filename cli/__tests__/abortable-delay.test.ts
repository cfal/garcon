import { describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { abortableDelay } from '../abortable-delay.js';

describe('abortableDelay', () => {
  test('removes the abort listener after a timer completes', async () => {
    const controller = new AbortController();

    await abortableDelay(0, controller.signal);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('clears the timer and listener when aborted', async () => {
    const controller = new AbortController();
    const waiting = abortableDelay(60_000, controller.signal);

    controller.abort(new Error('cancelled'));

    await expect(waiting).rejects.toThrow('cancelled');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
