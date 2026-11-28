// Oracle for server-agents/common/src/acp/in-band-failure.ts: the output type
// with the known call ids as a list, and the failure tracker driven by a list
// of calls, each answered in turn.
import {
  AcpInBandFailure,
  acpOutputUpdateType as outputUpdateType,
  type AcpFailureSplitter,
} from "../../../../server-agents/common/src/acp/in-band-failure.ts";

export function acpOutputUpdateType(update: unknown, knownCalls: string[]) {
  return outputUpdateType(update as Record<string, unknown>, (id) => knownCalls.includes(id));
}

// A `marker` reports what follows its first occurrence in a chunk as the
// failure, as an agent's splitter does; `null` publishes every chunk as text.
type Call =
  | { offer: string }
  | { continueOn: string | null }
  | { take: null }
  | { reset: null };

export function inBandFailure(marker: string | null, calls: Call[]): Array<string | null> {
  const failure = new AcpInBandFailure(((chunk) => {
    if (marker === null) return { text: chunk, failure: null };
    const at = chunk.indexOf(marker);
    return at < 0
      ? { text: chunk, failure: null }
      : { text: chunk.slice(0, at), failure: chunk.slice(at + marker.length) };
  }) as AcpFailureSplitter);
  return calls.map((call) => {
    if ('offer' in call) return failure.offer(call.offer);
    if ('continueOn' in call) return failure.continueOn(call.continueOn ?? undefined);
    if ('take' in call) return failure.take();
    failure.reset();
    return null;
  });
}
