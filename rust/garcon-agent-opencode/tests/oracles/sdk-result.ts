// Re-exports the pure functions and the error class of `sdk-result.ts` for
// recorded inputs.

export {
  OpenCodeSdkResultError,
  createOpenCodeRequestScope,
  hasOpenCodeResultError,
  isOpenCodeNotFoundResult,
  openCodeResultErrorMessage,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
} from "../../../../server-agents/opencode/src/agents/opencode/sdk-result.ts";
