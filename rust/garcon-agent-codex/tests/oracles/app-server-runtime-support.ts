import { CodexAppServerRpcError } from '../../../../server-agents/codex/src/agents/codex/app-server/client.ts';
import {
  hasTerminalPendingFinish as originalHasTerminalPendingFinish,
  humanizeCodexAppServerError as originalHumanize,
  isUtilityOverload as originalIsUtilityOverload,
} from '../../../../server-agents/codex/src/agents/codex/app-server/runtime-support.ts';

export {
  denialResponseForRequest,
  isActiveSessionStatus,
  isCapacityError,
  isTerminalSessionStatus,
  mergeFinishOptions,
} from '../../../../server-agents/codex/src/agents/codex/app-server/runtime-support.ts';

type NativeError = { message: string; rpcCode?: number; data?: unknown };

function createError(value: NativeError): Error {
  return value.rpcCode === undefined
    ? new Error(value.message)
    : new CodexAppServerRpcError(value.message, value.rpcCode, value.data);
}

export function humanizeCodexAppServerError(value: NativeError): string {
  return originalHumanize(createError(value));
}

export function isUtilityOverload(value: NativeError): boolean {
  return originalIsUtilityOverload(createError(value));
}

export function hasTerminalPendingFinish(value: Parameters<typeof originalHasTerminalPendingFinish>[0]['pendingFinish']): boolean {
  return originalHasTerminalPendingFinish({ pendingFinish: value } as Parameters<typeof originalHasTerminalPendingFinish>[0]);
}
