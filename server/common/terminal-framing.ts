import type { TerminalStreamServerMessage } from "../../common/terminal.js";

export const TERMINAL_STREAM_TARGET_MESSAGE_BYTES = 64 * 1024;
const OUTPUT_FRAGMENT_BASE64_CHARS = 48 * 1024;

export interface SerializedTerminalMessage {
  payload: string;
  byteLength: number;
}

export function serializeTerminalMessage(
  message: TerminalStreamServerMessage,
): SerializedTerminalMessage {
  const payload = JSON.stringify(message);
  return { payload, byteLength: Buffer.byteLength(payload, "utf8") };
}

export function expandTerminalMessageForDelivery(
  message: TerminalStreamServerMessage,
): TerminalStreamServerMessage[] {
  const expanded = expandTerminalPayload(message);
  return message.attachmentId ? expanded.map(part => ({ ...part, attachmentId: message.attachmentId })) : expanded;
}

function expandTerminalPayload(
  message: TerminalStreamServerMessage,
): TerminalStreamServerMessage[] {
  if (
    serializeTerminalMessage(message).byteLength <=
    TERMINAL_STREAM_TARGET_MESSAGE_BYTES
  )
    return [message];
  if (message.type === "terminal-output") {
    return fragmentOutput(message.terminalId, message.sequence, message.data);
  }
  if (message.type !== "terminal-attached") return [message];

  const expanded: TerminalStreamServerMessage[] = [{ ...message, replay: [] }];
  let batch: Extract<
    TerminalStreamServerMessage,
    { type: "terminal-replay-batch" }
  > = {
    type: "terminal-replay-batch",
    terminalId: message.terminal.terminalId,
    chunks: [],
  };
  const flushBatch = () => {
    if (batch.chunks.length === 0) return;
    expanded.push(batch);
    batch = { ...batch, chunks: [] };
  };

  for (const chunk of message.replay) {
    const encoded = {
      sequence: chunk.sequence,
      dataBase64: Buffer.from(chunk.data, "utf8").toString("base64"),
    };
    const nextBatch = { ...batch, chunks: [...batch.chunks, encoded] };
    if (
      serializeTerminalMessage(nextBatch).byteLength <=
      TERMINAL_STREAM_TARGET_MESSAGE_BYTES
    ) {
      batch = nextBatch;
      continue;
    }
    flushBatch();
    const singleBatch = { ...batch, chunks: [encoded] };
    if (
      serializeTerminalMessage(singleBatch).byteLength <=
      TERMINAL_STREAM_TARGET_MESSAGE_BYTES
    ) {
      batch = singleBatch;
    } else {
      expanded.push(
        ...fragmentBase64(
          message.terminal.terminalId,
          chunk.sequence,
          encoded.dataBase64,
        ),
      );
    }
  }
  flushBatch();
  return expanded;
}

function fragmentOutput(
  terminalId: string,
  sequence: number,
  data: string,
): TerminalStreamServerMessage[] {
  return fragmentBase64(
    terminalId,
    sequence,
    Buffer.from(data, "utf8").toString("base64"),
  );
}

function fragmentBase64(
  terminalId: string,
  sequence: number,
  dataBase64: string,
): TerminalStreamServerMessage[] {
  const fragmentCount = Math.max(
    1,
    Math.ceil(dataBase64.length / OUTPUT_FRAGMENT_BASE64_CHARS),
  );
  return Array.from({ length: fragmentCount }, (_, fragmentIndex) => ({
    type: "terminal-output-fragment" as const,
    terminalId,
    sequence,
    fragmentIndex,
    fragmentCount,
    dataBase64: dataBase64.slice(
      fragmentIndex * OUTPUT_FRAGMENT_BASE64_CHARS,
      (fragmentIndex + 1) * OUTPUT_FRAGMENT_BASE64_CHARS,
    ),
  }));
}
