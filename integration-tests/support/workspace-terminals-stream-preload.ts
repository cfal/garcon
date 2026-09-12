import { mock } from 'bun:test';
import {
  LocalWorkspaceTerminalService,
  type TerminalPty,
} from '../../server/execution-node/local-workspace-terminals.js';
import { withJsonBody } from '../../server/lib/json-route.js';
import createTerminalRoutes from '../../server/routes/terminals.js';
import { TerminalStreamHandler } from '../../server/ws/terminal-stream.js';
import * as transport from '../../server/ws/transport.js';
import { isRecord } from '../../common/json.js';

const buildTerminalRoutes = createTerminalRoutes;
const transportExports = { ...transport };
const sendPayload = transport.sendWebSocketPayload;
const outputs: ((data: string) => void)[] = [];
const exits: ((event: { exitCode: number }) => void)[] = [];
let now = Date.now();
let backpressureNext = false;
let handler: TerminalStreamHandler | undefined;
let socket: Parameters<TerminalStreamHandler['message']>[0] | undefined;
const reentrantOutput = process.env.GARCON_TEST_TERMINAL_REENTRANT_OUTPUT === '1';
const reentrantMetadata = process.env.GARCON_TEST_TERMINAL_REENTRANT_METADATA;
let metadataDelivered = false;
let terminalOwner: LocalWorkspaceTerminalService | undefined;
let attachedMessages = 0;

class ControlledTerminalService extends LocalWorkspaceTerminalService {
  constructor(options: ConstructorParameters<typeof LocalWorkspaceTerminalService>[0]) {
    super({
      ...options,
      ...(reentrantMetadata ? { replayBytes: 1 } : {}),
      spawnPty: () => {
        let output = (_data: string) => {};
        outputs.push((data) => output(data));
        return {
          write(data) {
            output(`synthetic-echo:${data}`);
          },
          resize() {},
          kill() {},
          onData(listener) {
            output = listener;
            return { dispose() {} };
          },
          onExit(listener) {
            exits.push(listener);
            return { dispose() {} };
          },
        } satisfies TerminalPty;
      },
    });
    terminalOwner = this;
  }

  override attach(...args: Parameters<LocalWorkspaceTerminalService['attach']>): void {
    if (reentrantMetadata && !metadataDelivered) {
      outputs[0]('a');
      outputs[0]('b');
    }
    super.attach(...args);
  }
}

class ControlledTerminalStream extends TerminalStreamHandler {
  constructor(owner: ConstructorParameters<typeof TerminalStreamHandler>[0]) {
    super(owner, () => now);
    handler = this;
  }

  override message(...args: Parameters<TerminalStreamHandler['message']>): void {
    socket = args[0];
    super.message(...args);
  }
}

mock.module('../../server/execution-node/local-workspace-terminals.js', () => ({
  LocalWorkspaceTerminalService: ControlledTerminalService,
}));
mock.module('../../server/ws/terminal-stream.js', () => ({
  TerminalStreamHandler: ControlledTerminalStream,
}));
mock.module('../../server/ws/transport.js', () => ({
  ...transportExports,
  sendWebSocketPayload(...args: Parameters<typeof sendPayload>) {
    if (reentrantOutput) {
      const message: unknown = JSON.parse(args[1]);
      if (isRecord(message)) {
        if (message.type === 'terminal-taken-over') outputs[0]('synthetic-during-takeover');
        if (message.type === 'terminal-attached' && ++attachedMessages === 2)
          outputs[0]('synthetic-during-attach');
      }
    }
    const status = sendPayload(...args);
    if (reentrantMetadata && !metadataDelivered) {
      const message: unknown = JSON.parse(args[1]);
      if (isRecord(message) && message.type === 'terminal-replay-truncated') {
        if (!terminalOwner || !socket || typeof message.terminalId !== 'string')
          throw new Error('Terminal metadata fixture is not ready');
        metadataDelivered = true;
        outputs[0]('c');
        if (reentrantMetadata === 'exit') exits[0]({ exitCode: 17 });
        else
          terminalOwner.rename(
            socket.data.principal,
            message.terminalId,
            'Synthetic renamed terminal',
          );
      }
    }
    if (!backpressureNext) return status;
    backpressureNext = false;
    return -1;
  },
}));
mock.module('../../server/routes/terminals.js', () => ({
  default(...args: Parameters<typeof buildTerminalRoutes>) {
    return {
      ...buildTerminalRoutes(...args),
      '/api/v1/test/terminal-stream': {
        POST: withJsonBody((body: unknown) => {
          if (!isRecord(body) || !socket || !handler || outputs.length !== 2)
            throw new Error('Terminal stream fixture is not ready');
          if (body.action === 'expire') {
            if (socket.data.principal.expiresAtMs === null)
              throw new Error('Expiry requires an authenticated socket');
            now = socket.data.principal.expiresAtMs;
            outputs[0]('synthetic-after-expiry');
          } else if (body.action === 'overflow') {
            backpressureNext = true;
            outputs[1]('synthetic-blocked');
            outputs[0]('x'.repeat(2 * 1024 * 1024));
            handler.drain(socket);
          } else {
            throw new Error('Unknown terminal stream fixture action');
          }
          return Response.json({ success: true });
        }),
      },
    };
  },
}));
