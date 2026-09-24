import type { CliConnectionOptions } from './args.js';
import { shellQuote } from './shell-quote.js';

export function connectionOptionEntries(connection: CliConnectionOptions): [string, string][] {
  const entries: [string, string][] = connection.runtimeFile
    ? [['--runtime-file', connection.runtimeFile]]
    : [['--workspace', connection.workspace], ['--config-dir', connection.configDir]];
  if (connection.runtimeFile && connection.expectedWorkspace !== undefined) {
    entries.push(['--workspace', connection.expectedWorkspace]);
  }
  if (connection.serverUrl !== undefined) entries.push(['--server', connection.serverUrl]);
  return entries;
}

export function connectionCommandPrefix(connection: CliConnectionOptions): string[] {
  return ['garcon-cli', ...connectionOptionEntries(connection).flatMap(([flag, value]) => [flag, shellQuote(value)])];
}
