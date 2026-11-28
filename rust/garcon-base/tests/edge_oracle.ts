import { AgentCallError, AgentIntegrationError } from "../../../server-agents/interface/src/errors.ts";
import { DomainError } from "../../../server/common/domain-error.ts";
import { getTokenFromRequest, parseJsonBody } from "../../../server/common/http-body.ts";
import { jsonError, jsonErrorFromUnknown } from "../../../server/common/http-error.ts";
import { runtimeProofResponse } from "../../../server/common/runtime-proof.ts";
import { expandTerminalMessageForDelivery, serializeTerminalMessage } from "../../../server/common/terminal-framing.ts";
import type { TerminalStreamServerMessage } from "../../../common/terminal.ts";
import type { ServerRuntimeState } from "../../../server/common/server-runtime.ts";

async function responseFields(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
}

export function jsonBodyFixture(contentType: string | null, body: string | null) {
  const headers = contentType === null ? {} : { "Content-Type": contentType };
  return parseJsonBody(new Request("http://localhost/", { method: "POST", body, headers }));
}

export function jsonBytesBodyFixture(contentType: string, body: string) {
  return parseJsonBody(new Request("http://localhost/", {
    method: "POST",
    body: new TextEncoder().encode(body),
    headers: { "Content-Type": contentType },
  }));
}

export function bearerFixture(authorization: string | null) {
  const headers = authorization === null ? {} : { Authorization: authorization };
  return getTokenFromRequest(new Request("http://localhost/", { headers }));
}

export function duplicateJsonBodyFixture(contentTypes: string[], body: string) {
  const headers: [string, string][] = contentTypes.map(value => ["Content-Type", value]);
  return parseJsonBody(new Request("http://localhost/", { method: "POST", body, headers }));
}

export function duplicateBearerFixture(values: string[]) {
  const headers: [string, string][] = values.map(value => ["Authorization", value]);
  return getTokenFromRequest(new Request("http://localhost/", { headers }));
}

export function jsonErrorFixture(
  error: string, status: number, code?: string, retryable?: boolean, details?: string,
) {
  return responseFields(jsonError(error, status, code, retryable, details));
}

type ErrorSpec =
  | { kind: "unknown"; value: unknown }
  | { kind: "error"; message: string }
  | { kind: "domain"; code: ConstructorParameters<typeof DomainError>[0]; message: string; status: number; retryable: boolean }
  | { kind: "integration"; code: ConstructorParameters<typeof AgentIntegrationError>[0]; message: string; retryable: boolean }
  | { kind: "call"; code: ConstructorParameters<typeof AgentCallError>[2]; message: string; outcome: ConstructorParameters<typeof AgentCallError>[0] };

export function unknownHttpErrorFixture(spec: ErrorSpec, status?: number) {
  const error = spec.kind === "call" ? new AgentCallError(spec.outcome, spec.message, spec.code)
    : spec.kind === "integration" ? new AgentIntegrationError(spec.code, spec.message, spec.retryable)
    : spec.kind === "domain" ? new DomainError(spec.code, spec.message, spec.status, spec.retryable)
    : spec.kind === "error" ? new Error(spec.message) : spec.value;
  return responseFields(jsonErrorFromUnknown(error, status));
}

export function runtimeProofFixture(state: ServerRuntimeState, url: string) {
  return responseFields(runtimeProofResponse(state, new URL(url)));
}

export function terminalFrameFixture(
  message: TerminalStreamServerMessage,
  repeat?: number,
) {
  if (message.type === "terminal-output" && repeat !== undefined) {
    message = { ...message, data: message.data.repeat(repeat) };
  }
  const serialized = serializeTerminalMessage(message);
  return {
    digest: new Bun.CryptoHasher("sha256").update(serialized.payload).digest("hex"),
    byteLength: serialized.byteLength,
    frames: expandTerminalMessageForDelivery(message).map((frame) => {
      const serialized = serializeTerminalMessage(frame);
      return { digest: new Bun.CryptoHasher("sha256").update(serialized.payload).digest("hex"), byteLength: serialized.byteLength };
    }),
  };
}
