import { OwnershipTransferPendingError, ownershipTransferPendingError } from '../../../server/controller/agents/ownership-transfer-fence.ts';
import { isDomainError } from '../../../server/common/domain-error.ts';
import { jsonErrorFromUnknown } from '../../../server/common/http-error.ts';

export async function ownershipTransferError(cause?: string) {
  const error = cause === undefined
    ? ownershipTransferPendingError()
    : new OwnershipTransferPendingError(new Error(cause));
  const response = jsonErrorFromUnknown(error);
  return {
    recognized: isDomainError(error),
    name: error.name,
    code: error.code,
    status: error.status,
    message: error.message,
    retryable: error.retryable,
    cause: error.cause instanceof Error ? error.cause.message : null,
    responseStatus: response.status,
    response: await response.text(),
  };
}
