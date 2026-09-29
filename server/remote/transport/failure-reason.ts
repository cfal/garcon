const MAX_REASON_LENGTH = 200;

// Stands in for a parse error's message, which can echo the payload it failed on.
export const MALFORMED_DATA = 'Malformed data';

// Summarizes why a connection, session, or message failed, for logs.
export function failureReason(error: unknown): string {
  if (error instanceof SyntaxError) return MALFORMED_DATA;
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}...` : message;
}
