import { expect, test } from 'bun:test';
import * as transport from '../limits.js';
import * as files from '@garcon/common/file-contracts';
import * as git from '@garcon/common/git-execution';
import * as cli from '../cli-protocol.js';
import * as usage from '@garcon/common/usage';
import { isContractVersions } from '@garcon/common/protocol-contracts';
import { decodeFileData } from '../file-protocol.js';
import { rpcWireV1 } from '../rpc-wire-v1.js';
import limits from './fixtures/limits-v1.json';

test('v1 limits and deadlines match their literal released budgets', () => {
  for (const [actual, expected] of [[transport, limits.transport], [files, limits.files], [git, limits.git], [cli, limits.cli], [usage, limits.usage]] as const) {
    expect(actual).toMatchObject(expected);
  }
});

test('v1 decoders accept boundary-sized catalogs, Files bodies and Git deadlines', () => {
  const versions = [1, 2, 3, limits.catalog.maximumVersion];
  const catalog = Object.fromEntries(Array.from({ length: limits.catalog.names }, (_, index) => [
    `c${String(index).padStart(limits.catalog.nameLength - 1, '0')}`, versions,
  ]));
  expect(isContractVersions(catalog)).toBe(true);
  expect(isContractVersions({ ...catalog, extra: versions })).toBe(false);
  expect(isContractVersions({ operation: [...versions, 4] })).toBe(false);
  const bytes = Buffer.alloc(limits.files.MAX_FILE_VIEW_BYTES, 120);
  expect(decodeFileData(bytes.toString('base64')).length).toBe(bytes.length);
  expect(() => decodeFileData(Buffer.alloc(bytes.length + 1).toString('base64'))).toThrow();
  const wire = rpcWireV1('git.commit');
  const request = { input: { projectPath: '/synthetic', files: ['file.txt'], message: 'Synthetic commit' }, budgetMs: limits.git.GIT_OPERATION_TIMEOUT_MS };
  expect(wire.request(request)).toEqual(request);
  expect(() => wire.request({ ...request, budgetMs: request.budgetMs + 1 })).toThrow();
});
