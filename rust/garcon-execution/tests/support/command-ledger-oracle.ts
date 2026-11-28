import {
  CommandLedger, commandLedgerKey, commandPayloadHash, compactCommandPayload,
} from '../../../../server/controller/commands/command-ledger.ts';

type Step = [string, ...any[]];

function errorResult(error: unknown) {
  const { name, message } = error as Error;
  return { error: { name, message } };
}

export async function commandLedgerTrace(
  options: ConstructorParameters<typeof CommandLedger>[0],
  steps: Step[],
) {
  const originalDate = globalThis.Date;
  let time = 60_123;
  globalThis.Date = class extends originalDate {
    constructor() { super(time); }
    static now() { return time; }
  } as typeof Date;
  try {
    const ledger = new CommandLedger(options);
    const waiting = new Map<string, { abort: AbortController; result: Promise<unknown> }>();
    const results: unknown[] = [];
    for (const [name, ...args] of steps) {
      try {
        let result: unknown;
        switch (name) {
          case 'time': time = args[0]; break;
          case 'hash': result = commandPayloadHash(args[0]); break;
          case 'compact': result = compactCommandPayload(args[0]); break;
          case 'key': result = commandLedgerKey(args[0], args[1], args[2]); break;
          case 'clearFork': result = await ledger.update(args[0], { forkPreparation: undefined }); break;
          case 'unsettledQueueReceiptKeys': result = [...ledger.unsettledQueueReceiptKeys(args[0])]; break;
          case 'startWait': {
            const abort = new AbortController();
            const result = ledger.waitForTurnTerminal(args[1], args[2], abort.signal)
              .catch(errorResult);
            waiting.set(args[0], { abort, result });
            break;
          }
          case 'cancelWait': waiting.get(args[0])!.abort.abort(new Error(args[1])); break;
          case 'finishWait': result = await waiting.get(args[0])!.result; break;
          default: result = await (ledger as any)[name](...args);
        }
        results.push(result ?? null);
      } catch (error) {
        results.push(errorResult(error));
      }
    }
    return { results, wire: JSON.stringify(results) };
  } catch (error) {
    return errorResult(error);
  } finally {
    globalThis.Date = originalDate;
  }
}
