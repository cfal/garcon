import { WorkspaceFileMentionResolver } from '../../server/chats/workspace-file-mention-resolver.js';
import { LocalExecutionPlacement } from '../../server/execution-nodes/local-placement.js';
import { DomainError } from '../../server/lib/domain-error.js';

const resolve = WorkspaceFileMentionResolver.prototype.resolve;
WorkspaceFileMentionResolver.prototype.resolve = function (command, target, signal) {
  const assertAvailable = LocalExecutionPlacement.prototype.assertAvailable;
  // Limits the fault to synchronous mention selection after ordinary execution admission.
  LocalExecutionPlacement.prototype.assertAvailable = () => {
    throw new DomainError('NODE_UNAVAILABLE', 'Synthetic mention placement failure', 409);
  };
  try { return resolve.call(this, command, target, signal); }
  finally { LocalExecutionPlacement.prototype.assertAvailable = assertAvailable; }
};
