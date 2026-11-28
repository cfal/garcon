import { DomainError } from "../../../../server/common/domain-error.js";
import { ProjectBoundaryError } from "../../../../server/common/path-boundary.js";
import { directoryCreationUnsupported } from "../../../../server/runtime/files/directory-creation.js";
import { directoryCreationError, fileOperationError, fileRevisionConflict } from "../../../../server/runtime/files/errors.js";

function fields(error: unknown) {
  if (!(error instanceof DomainError)) throw new Error("Expected a mapped domain error");
  const { code, message, status, retryable } = error;
  return { code, message, status, retryable };
}

export function mapFileOperationError(code: string) {
  return fields(fileOperationError(code === "boundary"
    ? new ProjectBoundaryError()
    : Object.assign(new Error("Synthetic IO error"), { code })));
}

export function mapDirectoryCreationError(code: string) {
  return fields(directoryCreationError(Object.assign(new Error("Synthetic IO error"), { code })));
}

export function revisionConflict() {
  return fields(fileRevisionConflict());
}

export function creationUnsupported() {
  return fields(directoryCreationUnsupported());
}
