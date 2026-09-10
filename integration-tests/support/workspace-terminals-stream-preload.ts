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
let now = Date.now();
let backpressureNext = false;
let handler: TerminalStreamHandler | undefined;
let socket: Parameters<TerminalStreamHandler['message']>[0] | undefined;

class ControlledTerminalService extends LocalWorkspaceTerminalService {
  constructor(options: ConstructorParameters<typeof LocalWorkspaceTerminalService>[0]) {
    super({
      ...options,
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
          onExit() {
            return { dispose() {} };
          },
        } satisfies TerminalPty;
      },
    });
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
    const status = sendPayload(...args);
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
