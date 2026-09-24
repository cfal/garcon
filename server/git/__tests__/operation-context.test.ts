import { expect, test } from 'bun:test';
import { markGitMutationDispatched, trackGitProcess, withGitOperation } from '../operation-context.js';

test('read completion rejects cancellation swallowed by a fallback', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Read cancelled', 'AbortError');
  const read = withGitOperation('/project', { signal: controller.signal }, async () => {
    controller.abort(reason);
    try {
      controller.signal.throwIfAborted();
    } catch {
      return { hasRemote: false };
    }
  });

  await expect(read).rejects.toBe(reason);
});

test('read completion checks cancellation after native processes settle', async () => {
  const controller = new AbortController();
  const native = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const reason = new DOMException('Read cancelled during settlement', 'AbortError');
  const read = withGitOperation('/project', { signal: controller.signal }, async () => {
    void trackGitProcess(() => native.promise);
    returned.resolve();
    return { hasRemote: true };
  });

  try {
    await returned.promise;
    controller.abort(reason);
    native.resolve();
    await expect(read).rejects.toBe(reason);
  } finally {
    native.resolve();
  }
});

test('confirmed mutation results survive cancellation during native settlement', async () => {
  const controller = new AbortController();
  const native = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const result = { success: true, indexSynchronized: false };
  const mutation = withGitOperation('/project', { signal: controller.signal, mutation: true }, async () => {
    markGitMutationDispatched();
    void trackGitProcess(() => native.promise);
    returned.resolve();
    return result;
  });

  try {
    await returned.promise;
    controller.abort();
    native.resolve();
    await expect(mutation).resolves.toBe(result);
  } finally {
    native.resolve();
  }
});

test('unconfirmed dispatched mutations retain their uncertain outcome', async () => {
  const controller = new AbortController();
  const mutation = withGitOperation('/project', { signal: controller.signal, mutation: true }, async () => {
    markGitMutationDispatched();
    controller.abort();
    controller.signal.throwIfAborted();
  });

  await expect(mutation).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
});
