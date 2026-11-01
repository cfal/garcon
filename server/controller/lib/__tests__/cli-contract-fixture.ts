import { CLI_WIRES_V1 } from '../../../remote/transport/cli-wire-v1.js';
import { registerCliRoutes } from '../cli-contracts.js';
import type { RouteMap } from '../http-route-types.js';

export function testCliContracts(routes: RouteMap = {}) {
  const handlers: RouteMap = {};
  for (const wire of CLI_WIRES_V1) {
    const [method, path] = wire.operation.split(' ') as [string, string];
    (handlers[path] ??= {})[method] = () => { throw new Error(`Unexpected test CLI route: ${wire.operation}`); };
  }
  for (const [path, methods] of Object.entries(routes)) handlers[path] = { ...handlers[path], ...methods };
  return registerCliRoutes(handlers);
}
