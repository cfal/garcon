import path from 'node:path';
import { SERVER_RUNTIME_FILENAME } from './server-runtime.js';

export type RuntimeKind = 'controller' | 'execution-node';
export type RuntimeSelection = 'auto' | RuntimeKind;

export function executionNodeDataDirectory(configDir: string): string {
  return path.join(configDir, 'execution-node');
}

export function cliGatewayRuntimeFile(dataDir: string): string {
  return path.join(dataDir, SERVER_RUNTIME_FILENAME);
}

export function cliRuntimeFile(configDir: string, runtime: RuntimeKind): string {
  return path.join(runtime === 'controller' ? configDir : executionNodeDataDirectory(configDir), SERVER_RUNTIME_FILENAME);
}
