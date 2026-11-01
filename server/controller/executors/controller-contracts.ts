import { HISTORY_READER_V1 } from '@garcon/common/executor-contracts';
import type { CliRegistration } from '../../remote/transport/cli-protocol.js';
import { createRoleContracts, type HandlerRegistration } from '../../remote/transport/rpc-registrations.js';
import { TRANSPORT_RPC_CLIENTS, TRANSPORT_RPC_HANDLERS } from '../../remote/transport/rpc.js';
import { FILES_RPC_CLIENTS } from '../../remote/client/remote-files.js';
import { GIT_RPC_CLIENTS } from '../../remote/client/remote-git.js';
import { TERMINAL_RPC_CLIENTS } from '../../remote/client/remote-terminals.js';
import { INTEGRATION_RPC_CLIENTS } from '../../remote/client/remote-agent-integration.js';
import { EXECUTOR_RPC_CLIENTS } from '../../remote/client/executor-client.js';
import { PROJECT_RPC_CLIENTS } from '../../remote/client/executor-generation.js';

export function controllerContracts(reverse: HandlerRegistration, cli: readonly CliRegistration[]) {
  return createRoleContracts('controller', {
    clients: [...TRANSPORT_RPC_CLIENTS, ...FILES_RPC_CLIENTS, ...GIT_RPC_CLIENTS, ...TERMINAL_RPC_CLIENTS,
      ...INTEGRATION_RPC_CLIENTS, ...EXECUTOR_RPC_CLIENTS, ...PROJECT_RPC_CLIENTS],
    handlers: [TRANSPORT_RPC_HANDLERS, reverse], resources: [HISTORY_READER_V1], cli,
  });
}
