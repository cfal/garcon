import type { AgentNativeSessionRef } from "../../../../server-agents/interface/src/index.ts";
import { AgentIntegrationError } from "../../../../server-agents/interface/src/index.ts";
import { createPathNativeSessionCodec, type PathNativeSessionValue } from "../../../../server-agents/common/src/native-session/path-native-session.ts";

const codec = createPathNativeSessionCodec("synthetic-provider");

export function encodePathNativeSession(value: PathNativeSessionValue) {
  return codec.encode(value);
}

export function decodePathNativeSession(value: AgentNativeSessionRef | null) {
  try {
    return { ok: true, value: codec.decode(value) };
  } catch (error) {
    if (!(error instanceof AgentIntegrationError)) throw error;
    return { ok: false, code: error.code, message: error.message };
  }
}
