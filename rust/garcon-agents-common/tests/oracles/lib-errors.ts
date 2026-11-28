import {
  errorMessage as originalErrorMessage,
  hasNodeErrorCode as originalHasNodeErrorCode,
} from "../../../../server-agents/common/src/lib/errors.ts";

export const errorMessage = (error: unknown) => originalErrorMessage(error);

export const hasNodeErrorCode = (error: unknown, code: string) => originalHasNodeErrorCode(error, code);
