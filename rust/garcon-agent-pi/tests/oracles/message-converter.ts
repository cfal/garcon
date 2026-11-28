import {
  convertPiMessage as convert,
  piFinalResponse,
} from '../../../../server-agents/pi/src/agents/pi/message-converter.ts';

export { piFinalResponse };

// Supplies the same clock as the Rust replay without changing explicit dates.
export function convertPiMessage(raw: unknown, options?: Parameters<typeof convert>[1]) {
  const clock = globalThis.Date;
  const fixtureNow = new clock(0);
  globalThis.Date = new Proxy(clock, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [fixtureNow.getTime()], newTarget);
    },
  });
  try {
    return convert(raw, options);
  } finally {
    globalThis.Date = clock;
  }
}
