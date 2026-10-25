import { describe, expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ExecutorProcess, reusableListenPort } from '../../support/execution-backend.js';
import { GarconProcess } from '../../support/garcon-process.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { throwingRejectionOf } from '../../support/promise-assertions.js';

describe('execution backend fixture', () => {
  test('skips reserved listen ports even when nothing is listening', async () => {
    const random = spyOn(Math, 'random');
    try {
      const reservedPort = await reusableListenPort();
      const reservedDraw = random.mock.results.at(-1);
      if (reservedDraw?.type !== 'return') throw new Error('Expected a completed random draw');
      random.mockClear();
      random.mockReturnValueOnce(reservedDraw.value);

      expect(await reusableListenPort([reservedPort])).not.toBe(reservedPort);
      expect(random.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      random.mockRestore();
    }
  });

  test('fails bounded allocation rather than returning a reserved port', async () => {
    const random = spyOn(Math, 'random');
    try {
      const reservedPort = await reusableListenPort();
      const reservedDraw = random.mock.results.at(-1);
      if (reservedDraw?.type !== 'return') throw new Error('Expected a completed random draw');
      random.mockReturnValue(reservedDraw.value);
      random.mockClear();

      expect(await throwingRejectionOf(reusableListenPort([reservedPort]))).toThrow('No free');
      expect(random).toHaveBeenCalledTimes(20);
    } finally {
      random.mockRestore();
    }
  });

  test.each(['restartGarcon', 'crashAndRestartGarcon'] as const)(
    '%s does not allocate the stopped worker port to the replacement controller',
    async (restart) => {
      const [floor] = (await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'))
        .trim().split(/\s+/).map(Number);
      const workerStarts = spyOn(ExecutorProcess, 'start');
      const random = spyOn(Math, 'random');
      try {
        await withIntegrationFixture(`worker-port-${restart}`, async (fixture) => {
          const connection = workerStarts.mock.calls[0]![0].connection;
          if (connection.kind !== 'listen') throw new Error('Expected a listening worker');

          await fixture[restart]({
            beforeStart: async () => {
              const workerPortDraw = (floor! - 1 - connection.port + 0.5) / 10_000;
              random.mockReturnValueOnce(workerPortDraw);
              expect(await reusableListenPort()).toBe(connection.port);
              random.mockReturnValueOnce(workerPortDraw);
            },
          });

          expect(Number(new URL(fixture.garcon.baseUrl).port)).not.toBe(connection.port);
          expect(workerStarts).toHaveBeenCalledTimes(2);
          expect(workerStarts.mock.calls[1]![0].connection).toEqual(connection);
          await fixture.client.ping();
        }, { executionBackend: 'remote-controller-dials' });
      } finally {
        random.mockRestore();
        workerStarts.mockRestore();
      }
    },
    120_000,
  );

  test('retains replacement controller diagnostics when the worker cannot start', async () => {
    const controllerStarts = spyOn(GarconProcess, 'start');
    const workerStarts = spyOn(ExecutorProcess, 'start');
    try {
      await withIntegrationFixture('worker-startup-diagnostics', async (fixture) => {
        workerStarts.mockRejectedValueOnce(new Error('Synthetic worker startup failure'));
        const failure = await fixture.restartGarcon().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error('Expected worker startup failure');

        const controllerStart = controllerStarts.mock.results[1];
        if (controllerStart?.type !== 'return') throw new Error('Expected controller startup');
        const replacement = await controllerStart.value;
        expect(failure.message).toContain('Synthetic worker startup failure');
        expect(failure.message).toContain(`Controller logs (${replacement.baseUrl}):`);
        expect(failure.message).toContain(replacement.describeLogs());
        expect(failure.message).toContain('Worker logs:');
      }, { executionBackend: 'remote-controller-dials' });
    } finally {
      workerStarts.mockRestore();
      controllerStarts.mockRestore();
    }
  }, 120_000);
});
