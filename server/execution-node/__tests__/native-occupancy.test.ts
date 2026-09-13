import { expect, test } from 'bun:test';
import { NodeNativeOccupancy } from '../native-occupancy.js';

test('execution and auxiliary work share capacity with exact, idempotent release', () => {
  const occupancy = new NodeNativeOccupancy(2);
  const execution = occupancy.reserveExecution('synthetic-chat');
  const auxiliary = occupancy.reserveAuxiliary();
  expect(occupancy.active).toBe(2);
  expect(() => occupancy.reserveExecution('synthetic-sibling')).toThrow('reserved by other work');
  execution.release();
  execution.release();
  expect(occupancy.active).toBe(1);
  const sibling = occupancy.reserveExecution('synthetic-sibling');
  auxiliary.release();
  sibling.release();
  expect(occupancy.active).toBe(0);
});

test('a chat cannot acquire a successor while its original reservation remains occupied', () => {
  const occupancy = new NodeNativeOccupancy(3);
  const original = occupancy.reserveExecution('synthetic-chat');
  original.enter();
  expect(() => occupancy.reserveExecution('synthetic-chat')).toThrow('reserved by other work');
  occupancy.reserveExecution('synthetic-sibling').release();
  original.release();
  occupancy.reserveExecution('synthetic-chat').release();
  expect(occupancy.active).toBe(0);
});

test('containment fences admission without releasing reservations or reopening on late settlement', () => {
  const occupancy = new NodeNativeOccupancy(1);
  const original = occupancy.reserveExecution('synthetic-chat');
  occupancy.close();
  expect(occupancy.active).toBe(1);
  original.release();
  expect(occupancy.active).toBe(0);
  expect(() => occupancy.reserveAuxiliary()).toThrow('retired');
});


test('prepared tickets share no native chat authority until one enters', () => {
  const occupancy = new NodeNativeOccupancy(2);
  const first = occupancy.reserveExecution('synthetic-chat');
  const other = occupancy.reserveExecution('synthetic-chat');
  first.enter();
  expect(() => other.enter()).toThrow('reserved by other work');
  other.release();
  expect(() => occupancy.reserveExecution('synthetic-chat')).toThrow('reserved by other work');
  first.release();
  occupancy.reserveExecution('synthetic-chat').release();
  expect(occupancy.active).toBe(0);
});
