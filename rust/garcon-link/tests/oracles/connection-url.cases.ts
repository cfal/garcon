import { expect, test } from "bun:test";
import {
  executorConnectionUrl,
  parseConnectionUrl,
  validateExecutorSocketUrl,
} from "../../../../server/remote/transport/connection-url.js";

test("round-trips a deterministic link descriptor for recording", () => {
  const socketUrl = "wss://example.com/any-prefix?route=worker&tag=a&tag=b";
  const secret = Buffer.alloc(32).toString("base64url");
  const descriptor = executorConnectionUrl(socketUrl, secret);
  expect(parseConnectionUrl(descriptor)).toEqual({ socketUrl, secret });
  expect(validateExecutorSocketUrl(socketUrl, { noTls: false })).toBe(socketUrl);
});
