import { withTimeout } from './deferred.js';

export async function awaitFixtureSetup<T>(
  creation: Promise<T>,
  dispose: (fixture: T) => Promise<void>,
  timeoutMs: number,
  describeTimeout: () => string,
): Promise<T> {
  try {
    return await withTimeout(creation, timeoutMs, describeTimeout);
  } catch (error) {
    // A deadline does not cancel creation; late resources still need an owner.
    void creation.then(dispose, () => undefined).catch(console.error);
    throw error;
  }
}
