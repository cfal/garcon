import { expect, test } from 'bun:test';
import { contractWireShapes } from './wire-shapes.js';
import released from './fixtures/released-contracts.json';
import errors from '../rpc-errors-v1.json';

test('released contracts freeze their own expanded payloads, requirements and policies', async () => {
  const shapes = contractWireShapes();
  expect(Object.keys(shapes.contracts).sort()).toEqual(released);
  for (const [name, shape] of Object.entries(shapes.contracts)) {
    const fixture = await Bun.file(new URL(`./fixtures/contracts/${name}.json`, import.meta.url)).json();
    expect(shape, name).toEqual(fixture);
  }
  expect(shapes.bootstrap).toEqual(await Bun.file(new URL('./fixtures/bootstrap-1-shapes.json', import.meta.url)).json());
  expect(shapes.cliBootstrap).toEqual(await Bun.file(new URL('./fixtures/cli-bootstrap-1-shapes.json', import.meta.url)).json());
  expect(errors).toEqual(await Bun.file(new URL('./fixtures/rpc-errors-v1.json', import.meta.url)).json());
}, 30_000);
