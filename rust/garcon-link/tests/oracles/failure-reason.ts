import { failureReason } from "../../../../server/remote/transport/failure-reason.js";

export function reasonWithStack(kind: string, message: string, stack?: string): string {
  if (kind === "error") return failureReason(new Error(message));
  if (kind !== "syntax") return failureReason(message);
  const error = new SyntaxError(message);
  error.stack = stack;
  return failureReason(error);
}
