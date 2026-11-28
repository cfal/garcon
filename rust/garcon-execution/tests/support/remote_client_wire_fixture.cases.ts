import { expect, test } from 'bun:test';
import { fileFailure, historyRows, readReply, saveWire } from './remote_client_wire_fixture.ts';

test('reads bytes from canonical base64 and checks the returned revision', async () => {
  expect(await readReply({ data: 'AP+A', path: '/fixture/file.txt', revision: 'v1:before' })).toEqual({
    bytes: [0, 255, 128], path: '/fixture/file.txt', revision: 'v1:before',
  });
  expect(await readReply({ data: '', path: '', revision: 'v1:empty' })).toEqual({ bytes: [], path: '', revision: 'v1:empty' });
  await expect(readReply({ data: '/w', path: '/fixture/file.txt', revision: 'v1:before' })).rejects.toMatchObject({ code: 'FILE_INVALID_DATA' });
  await expect(readReply({ data: 'AP+A', path: '/fixture/file.txt', revision: 'flat' })).rejects.toMatchObject({ code: 'FILE_INVALID_DATA' });
  await expect(readReply(null)).rejects.toMatchObject({ code: 'FILE_INVALID_DATA' });
});

test('shapes the save envelope on the actual RPC path', async () => {
  const request = { content: 'a\0😀\n', expectedRevision: 'v1:before', conflictResolution: 'overwrite', projectPath: '/fixture', filePath: 'file.txt' } as const;
  expect(await saveWire(request)).toBe('{"expectedRevision":"v1:before","conflictResolution":"overwrite","projectPath":"/fixture","filePath":"file.txt","data":"YQDwn5iACg=="}');
  await expect(saveWire({ ...request, expectedRevision: 'invalid-revision' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

test('reports potentially committed mutations differently from definite loss', async () => {
  await expect(fileFailure('save', 'unknown')).rejects.toMatchObject({ code: 'FILE_SAVE_OUTCOME_UNKNOWN' });
  await expect(fileFailure('createDirectory', 'unknown')).rejects.toMatchObject({ code: 'FILE_CREATE_OUTCOME_UNKNOWN' });
  expect(await fileFailure('save', 'not-dispatched')).toEqual({ outcome: 'not-dispatched', code: 'UNAVAILABLE', message: 'synthetic file failure' });
  expect(await fileFailure('createDirectory', 'rejected')).toEqual({ outcome: 'rejected', code: 'UNAVAILABLE', message: 'synthetic file failure' });
});

test('rebuilds messages from a history page or rejects unreadable rows', async () => {
  expect(await historyRows([{ message: { type: 'assistant-message', content: 'synthetic answer', timestamp: '2026-01-01T00:00:00Z', extra: 'do not echo' } }])).toBe(
    '[{"message":{"timestamp":"2026-01-01T00:00:00Z","content":"synthetic answer","type":"assistant-message"}}]',
  );
  expect(await historyRows([{ message: { type: 'assistant-message', content: 'sample' }, providerMeta: { n: 1.0, big: 9007199254740993, exp21: 1e21, tiny: 1e-7 } }])).toBe(
    '[{"message":{"timestamp":"","content":"sample","type":"assistant-message"},"providerMeta":{"n":1,"big":9007199254740992,"exp21":1e+21,"tiny":1e-7}}]',
  );
  await expect(historyRows([{ message: { type: 'synthetic-future-type' } }])).rejects.toThrow('Unknown normalized message');
  await expect(historyRows([{ message: [] }])).rejects.toThrow('Invalid normalized message');
  await expect(historyRows(null)).rejects.toThrow('Invalid imported rows');
});
