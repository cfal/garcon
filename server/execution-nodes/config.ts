import { stat } from 'node:fs/promises';

export interface ExecutionNodeConnectionConfig {
  readonly nodeId: string;
  readonly secret: string;
  readonly connection: { readonly kind: 'dial'; readonly url: string } | { readonly kind: 'listen'; readonly port: number };
  readonly allowInsecureDevelopment: boolean;
}

export interface ExecutionNodeWorkerConfig extends ExecutionNodeConnectionConfig {
  readonly workspaceDir: string;
  readonly projectBasePath: string;
}

export async function readExecutionNodeConfig(path: string): Promise<ExecutionNodeWorkerConfig> {
  const stats = await stat(path);
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) throw new Error('Execution-node config must be accessible only to its OS account');
  const config: unknown = await Bun.file(path).json();
  if (!config || typeof config !== 'object') throw new Error('Invalid execution-node configuration');
  const value = config as Record<string, unknown>;
  const connection = value.connection as Record<string, unknown> | undefined;
  if (typeof value.nodeId !== 'string' || !value.nodeId || typeof value.secret !== 'string' || value.secret.length < 32
    || typeof value.workspaceDir !== 'string' || !value.workspaceDir
    || typeof value.projectBasePath !== 'string' || !value.projectBasePath
    || typeof value.allowInsecureDevelopment !== 'boolean' || !connection
    || !(connection.kind === 'dial' && typeof connection.url === 'string'
      || connection.kind === 'listen' && typeof connection.port === 'number' && Number.isInteger(connection.port)
        && connection.port >= 0 && connection.port <= 65535)) {
    throw new Error('Invalid execution-node configuration');
  }
  return config as ExecutionNodeWorkerConfig;
}
