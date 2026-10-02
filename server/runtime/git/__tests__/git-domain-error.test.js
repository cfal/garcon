import { describe, it, expect } from "bun:test";
import { GitDomainError } from "../git-domain-error.js";

describe("GitDomainError", () => {
  it("extends Error with name and code", () => {
    const err = new GitDomainError("INVALID_INPUT", "bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitDomainError");
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toBe("bad input");
  });
});
