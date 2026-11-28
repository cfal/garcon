// Oracle for server-agents/common/src/acp/errors.ts: its predicates on the
// AcpRpcError the transport builds from an error reply, and on another error.
import {
  AcpRpcError,
  isInvalidParamsError as invalidParams,
  isMethodNotFoundError as methodNotFound,
  isRecoverableLoadFailure as recoverable,
  isSessionNotFoundError as sessionNotFound,
} from "../../../../server-agents/common/src/acp/errors.ts";

function rpcError(message: unknown, code: unknown, data?: unknown): AcpRpcError {
  return new AcpRpcError(message as string, code as number, data);
}

export function isMethodNotFoundError(message: unknown, code: unknown, data: unknown) {
  return methodNotFound(rpcError(message, code, data));
}

export function isInvalidParamsError(message: unknown, code: unknown, data: unknown) {
  return invalidParams(rpcError(message, code, data));
}

export function isSessionNotFoundError(message: unknown, code: unknown, data: unknown) {
  return sessionNotFound(rpcError(message, code, data));
}

export function isRecoverableLoadFailure(message: unknown, code: unknown, data: unknown) {
  return recoverable(rpcError(message, code, data));
}

export function isRecoverableLoadFailureOfOther(error: unknown) {
  return recoverable(error);
}
