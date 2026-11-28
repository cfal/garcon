import { expect, test } from 'bun:test';
import { echo } from './functions.js';

let inFlight = 0;
for (const label of ['first', 'second']) {
  test.concurrent(label, async () => {
    inFlight += 1;
    try {
      expect(inFlight).toBe(1);
      await Bun.sleep(0);
      expect(echo(label)).toBe(label);
    } finally {
      inFlight -= 1;
    }
  });
}
