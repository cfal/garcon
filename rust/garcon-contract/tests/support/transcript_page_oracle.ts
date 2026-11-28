import { applyTranscriptAppend as append, parseChatHistoryResponse as history, parseTranscriptMessages as messages, parseTranscriptMessage as message } from "../../../../common/chat-view.ts";
import { parseChatSnapshotResponse as snapshot } from "../../../../common/chat-snapshot.ts";
import { parseTranscriptAnchorResponse as anchor, transcriptAnchorContinuation, transcriptAnchorWindow } from "../../../../common/transcript-anchor-page.ts";
import { CommandOutputMessage, parseChatMessage } from "../../../../common/chat-types.ts";
import { projectCommandOutput as project } from "../../../../common/command-output-projection.ts";
import { transcriptEntryCategoryForMessage as category } from "../../../../common/transcript-entry-categories.ts";

export { parseChatHistoryState, parseResendCandidates } from "../../../../common/chat-view.ts";
export { parseTranscriptAnchorRequest } from "../../../../common/transcript-anchor-page.ts";
export { isTranscriptEntryOptionalCategory, canonicalTranscriptEntryOptionalCategories } from "../../../../common/transcript-entry-categories.ts";

export function parseTranscriptMessage(value: unknown) {
  return JSON.stringify(message(value));
}

export function parseTranscriptMessages(value: unknown) {
  return JSON.stringify(messages(value));
}

export function applyTranscriptAppend(current: unknown, change: { firstOrdinal: number; lastOrdinal: number; messages: unknown }, lastOrdinal: number) {
  const before = messages(current);
  const added = messages(change.messages);
  if (!before || !added) throw new TypeError("Fixture must provide ordered transcript messages");
  return JSON.stringify(append(before, { ...change, messages: added }, lastOrdinal));
}

export function parseChatHistoryResponse(request: Parameters<typeof history>[0], value: unknown) {
  return JSON.stringify(history(request, value));
}

export function parseChatSnapshotResponse(value: unknown) {
  return JSON.stringify(snapshot(value));
}

export function parseTranscriptAnchorResponse(request: Parameters<typeof anchor>[0], value: unknown) {
  return JSON.stringify(anchor(request, value));
}

export function anchorWindow(request: Parameters<typeof anchor>[0], value: unknown) {
  const page = anchor(request, value);
  if (!("pageStatus" in page)) throw new TypeError("Fixture must provide an available page");
  return JSON.stringify(transcriptAnchorWindow(page));
}

export function anchorContinuation(request: Parameters<typeof anchor>[0], value: unknown) {
  const page = anchor(request, value);
  if (!("pageStatus" in page)) throw new TypeError("Fixture must provide an available page");
  return transcriptAnchorContinuation(page);
}

export function projectCommandOutput(values: (Parameters<typeof parseChatMessage>[0])[]) {
  const rows = values.map((value) => {
    const output = value as CommandOutputMessage | null;
    return output?.type === "command-output"
      ? new CommandOutputMessage(output.timestamp, output.commandId, output.channel, output.format, output.content, output.context, output.offset)
      : parseChatMessage(value);
  });
  return JSON.stringify([...project(rows)].map(([index, message]) => [index, message, message === rows[index]]));
}

export function transcriptEntryCategoryForMessage(value: unknown) {
  const message = parseChatMessage(value);
  if (!message) throw new TypeError("Fixture must provide a recognized message");
  return category(message);
}
