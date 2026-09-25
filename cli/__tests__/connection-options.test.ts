import { expect, test } from 'bun:test';
import { parseCliArgs } from '../args.js';
import { connectionCommandPrefix, connectionOptionEntries } from '../connection-options.js';

const local = { runtime: 'controller' as const, configDir: '/config with space', serverUrl: 'http://127.0.0.1:8080' };

test('connection arguments preserve local selectors and an explicit server assertion', () => {
  expect(connectionOptionEntries(local)).toEqual([
    ['--config-dir', '/config with space'], ['--runtime', 'controller'], ['--server', local.serverUrl],
  ]);
  expect(connectionCommandPrefix(local).join(' ')).toBe(
    "garcon-cli --config-dir '/config with space' --runtime 'controller' --server 'http://127.0.0.1:8080'",
  );
});

test('resolved root and role override ambient defaults and preserve URL assertions', () => {
  const configDir = "/private/worker's config";
  const connection = { ...local, configDir, runtime: 'execution-node' as const };
  const entries = connectionOptionEntries(connection);
  expect(entries).toEqual([
    ['--config-dir', configDir], ['--runtime', 'execution-node'], ['--server', local.serverUrl],
  ]);
  expect(parseCliArgs([...entries.flat(), 'list', 'agents'], {
    GARCON_RUNTIME: 'controller', GARCON_CONFIG_DIR: '/wrong',
  })).toMatchObject({ configDir, runtime: 'execution-node', serverUrl: local.serverUrl });
  expect(connectionCommandPrefix(connection).join(' ')).toContain("--config-dir '/private/worker'\"'\"'s config'");
});
