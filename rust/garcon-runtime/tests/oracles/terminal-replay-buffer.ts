import type { TerminalOutputChunk } from "../../../../common/terminal.js";
import { TerminalReplayBuffer } from "../../../../server/runtime/terminals/terminal-replay-buffer.js";

export function replayTerminalOutput(limit: number, chunks: TerminalOutputChunk[], cursor: number) {
  const buffer = new TerminalReplayBuffer(limit);
  for (const chunk of chunks) buffer.append(chunk);
  return {
    byteLength: buffer.byteLength,
    firstRetainedSequence: buffer.firstRetainedSequence,
    chunks: buffer.after(cursor),
  };
}
