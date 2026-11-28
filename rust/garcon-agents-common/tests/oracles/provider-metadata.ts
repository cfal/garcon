import { AssistantMessage } from "../../../../common/chat-types.ts";
import { attachNativeMessageSource, type NativeMessageSource } from "../../../../server-agents/interface/src/native-message-source.ts";
import { providerMetadata } from "../../../../server-agents/common/src/native-session/provider-metadata.ts";
import { runtimeRows } from "../../../../server-agents/common/src/execution/runtime-events.ts";

function message(source: NativeMessageSource | null, content: string) {
  return attachNativeMessageSource(new AssistantMessage("2026-01-01T00:00:00Z", content), source);
}

export function metadataFor(source: NativeMessageSource | null) {
  return providerMetadata(message(source, ""));
}

export function rowsFor(source: NativeMessageSource | null, content: string) {
  return JSON.parse(JSON.stringify(runtimeRows([message(source, content)])));
}
