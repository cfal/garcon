const MAX_REASON_LENGTH = 200;

// Stands in for a parse error's message, which can echo the payload it failed on.
export const MALFORMED_DATA = 'Malformed data';

// Summarizes why a connection, session, or message failed, for logs and for the
// error an executor shows its clients. A parse error is described by where it
// was thrown instead of by its message.
export function failureReason(error: unknown): string {
  let reason: string;
  if (error instanceof SyntaxError) reason = malformedData(error);
  else if (error instanceof Error) reason = error.message;
  else reason = String(error);
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}...` : reason;
}

// Adds the first stack frame with a source position. Bun can omit the frames
// nearest the parser, so this is the nearest caller it kept, if any. The stack
// opens with the error's name and message, skipped whole because the message
// can span lines.
function malformedData(error: SyntaxError): string {
  const header = String(error);
  const frames = error.stack?.startsWith(header) ? error.stack.slice(header.length).split('\n') : [];
  const location = frames.map((frame) => frame.trim()).find((frame) => /^at .*:\d+:\d+\)?$/.test(frame));
  return location ? `${MALFORMED_DATA} ${location}` : MALFORMED_DATA;
}
