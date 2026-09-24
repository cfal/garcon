import { expect, test } from 'bun:test';
import { parseCliArgs } from '../args.js';
import { connectionCommandPrefix, connectionOptionEntries } from '../connection-options.js';

const local = { workspace: 'work', configDir: '/config with space', serverUrl: 'http://127.0.0.1:8080' };

test('connection arguments preserve local selectors and an explicit server assertion', () => {
  expect(connectionOptionEntries(local)).toEqual([
    ['--workspace', 'work'], ['--config-dir', '/config with space'], ['--server', local.serverUrl],
  ]);
  expect(connectionCommandPrefix(local).join(' ')).toBe(
    "garcon-cli --workspace 'work' --config-dir '/config with space' --server 'http://127.0.0.1:8080'",
  );
});

test('a pinned runtime excludes ambient workspace selectors and preserves explicit assertions', () => {
  const runtimeFile = "/private/worker's runtime.json";
  const connection = { ...local, runtimeFile, expectedWorkspace: 'remote' };
  const entries = connectionOptionEntries(connection);
  expect(entries).toEqual([
    ['--runtime-file', runtimeFile], ['--workspace', 'remote'], ['--server', local.serverUrl],
  ]);
  expect(parseCliArgs([...entries.flat(), 'list', 'agents'], {
    GARCON_CLI_RUNTIME: runtimeFile, GARCON_WORKSPACE: 'wrong', GARCON_CONFIG_DIR: '/wrong',
  })).toMatchObject({ runtimeFile, expectedWorkspace: 'remote', serverUrl: local.serverUrl });
  expect(connectionCommandPrefix(connection).join(' ')).toContain("--runtime-file '/private/worker'\"'\"'s runtime.json'");
  expect(connectionOptionEntries({ ...connection, expectedWorkspace: undefined })).toEqual([
    ['--runtime-file', runtimeFile], ['--server', local.serverUrl],
  ]);
});
