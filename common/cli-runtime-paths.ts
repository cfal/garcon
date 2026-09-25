import path from 'node:path';

export function executionNodeDataDirectory(configDir: string): string {
  return path.join(configDir, 'execution-node');
}

export function cliGatewayRuntimeDirectory(dataDir: string): string {
  return path.join(dataDir, 'run');
}

export function cliGatewayRuntimeFile(dataDir: string, runtimeId: string): string {
  return path.join(cliGatewayRuntimeDirectory(dataDir), `cli-${runtimeId}.json`);
}

export function isCliGatewayRuntimeFilename(name: string): boolean {
  return /^cli-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(name);
}
