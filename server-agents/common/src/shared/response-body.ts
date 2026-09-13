import type { NativeCleanupObserver } from '../execution/native-cleanup.js';

/** Retains the response reader through EOF or observed cancellation cleanup. */
export async function readResponseText(response: Response, cleanup: NativeCleanupObserver | null = null): Promise<string> {
  if (!cleanup) return response.text();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let readFailure: { error: unknown } | null = null;
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch (error) { readFailure = { error }; throw error; }
      const { done, value } = chunk;
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch((error: unknown) => {
      // Cancelling an errored stream repeats its stored read error without invoking underlying cleanup.
      if (!readFailure || !Object.is(error, readFailure.error)) cleanup.failed(error);
    });
    reader.releaseLock();
  }
}

export async function readResponseJson(response: Response, cleanup: NativeCleanupObserver | null = null): Promise<unknown> {
  if (!cleanup) return response.json();
  return JSON.parse(await readResponseText(response, cleanup)) as unknown;
}
