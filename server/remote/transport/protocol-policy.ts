import type { CliOperationDefinition } from '../../../common/cli-contracts.js';
import { supportsDefinition, type ProtocolProfile } from '../../../common/protocol-contracts.js';
import { DomainError } from '../../common/domain-error.js';

export function assertCliSupported(profile: Pick<ProtocolProfile, 'contracts'>, definition: CliOperationDefinition): void {
  if (!supportsDefinition(profile.contracts, definition)) {
    throw new DomainError('OPERATION_UNSUPPORTED', 'Executor protocol does not support this CLI operation', 422);
  }
}
