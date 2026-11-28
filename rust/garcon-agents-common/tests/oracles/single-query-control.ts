import type { AgentSingleQueryRequest } from "@garcon/server-agent-interface";
import { isThinkingMode } from "../../../../common/chat-modes.ts";
import {
  singleQueryRuntimeOptions,
  withSingleQueryControl,
} from "../../../../server-agents/common/src/shared/single-query-control.ts";

// The guard of the typed request: its thinking mode must be one the request accepts.
export function isSingleQueryRequest(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && isThinkingMode((value as { thinkingMode?: unknown }).thinkingMode);
}

// The runtime options beside a marker for the request's own signal.
export function runtimeOptions(input: unknown) {
  const request = { ...(input as object), signal: new AbortController().signal } as AgentSingleQueryRequest;
  const values = singleQueryRuntimeOptions(request);
  return { ...values, signal: values.signal === request.signal ? "the request signal" : "another signal" };
}

// The message a caller sees when the timeout wins, or `operation` when a
// 200 ms operation ends first.
export async function timeoutAfter(timeoutMs: unknown): Promise<string> {
  try {
    return await withSingleQueryControl({ timeoutMs }, () => new Promise<string>((resolve) => {
      setTimeout(() => resolve("operation"), 200);
    }));
  } catch (error) {
    return (error as Error).message;
  }
}
