// A parse error's message can echo the text it failed on, such as a credential
// or chat content, so a stored document that fails to parse is named instead.
export class MalformedStoredJsonError extends Error {
  override readonly name = 'MalformedStoredJsonError';

  constructor(readonly subject: string) {
    super(`${subject} is not valid JSON`);
  }
}

export function parseStoredJson(text: string, subject: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new MalformedStoredJsonError(subject); }
}
