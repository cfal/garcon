import type { AgentAttachment } from "../../../../common/agent-execution.ts";
import {
  anthropicMessagesUrl, buildAnthropicCompatibleUserContent,
} from "../../../../server-agents/common/src/direct/anthropic-compatible-chat-runtime.ts";
import { buildOpenAiCompatibleUserContent } from "../../../../server-agents/common/src/direct/openai-compatible-chat-runtime.ts";
import {
  buildOpenAiResponsesUserContent, extractOpenAiResponsesTextContent,
} from "../../../../server-agents/common/src/direct/openai-compatible-responses-runtime.ts";
import {
  ResponsesRequestError, consumeResponsesStreamEvent, extractResponsesOutputText,
  isUnresolvedCheckpoint, type ResponsesStreamState,
} from "../../../../server-agents/common/src/direct/openai-compatible-responses-protocol.ts";

export const messagesUrl = anthropicMessagesUrl;
export const messagesContent = (text: string, attachments: AgentAttachment[]) => buildAnthropicCompatibleUserContent(text, attachments);
export const chatContent = (text: string, attachments: AgentAttachment[]) => buildOpenAiCompatibleUserContent(text, attachments);
export const responsesContent = (text: string, attachments: AgentAttachment[]) => {
  const content = buildOpenAiResponsesUserContent(text, attachments);
  return { content, text: extractOpenAiResponsesTextContent(content) };
};
export const responsesOutput = extractResponsesOutputText;
export const responsesStream = (events: unknown[]) => {
  const state: ResponsesStreamState = {
    text: "", errorMessage: null, errorCode: null, outputAccepted: false, responseId: null, terminal: null,
  };
  for (const event of events) consumeResponsesStreamEvent(state, event);
  return state;
};
export const unresolvedCheckpoint = (code: string | null, accepted: boolean) =>
  isUnresolvedCheckpoint(new ResponsesRequestError("synthetic", code, accepted));
