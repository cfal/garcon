import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperations } from "../../../runtime/git/git-service.js";
import { initRepoWithCommit } from "../../../runtime/git/__tests__/repository-fixture.js";
import { GitDomainError } from "../../../runtime/git/git-domain-error.js";
import { gitHttpError } from "../http-error.js";

const toHttpError = (error) => gitHttpError(error, mockClassifyGitError);

function mockClassifyGitError(error) {
  const msg = error?.message || "";
  if (msg.includes("hostname")) {
    return {
      code: "NETWORK",
      status: 502,
      message: "Could not reach the remote host.",
      details: "Verify network access.",
    };
  }
  return {
    code: "UNKNOWN",
    status: 500,
    message: msg || "Git operation failed.",
  };
}

it("rejects paths outside the project root as invalid input", async () => {
  const projectPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "garcon-git-outside-commit-"),
  );
  const git = createGitOperations();

  try {
    await initRepoWithCommit(projectPath);
    let rejection;
    try {
      await git.commit({
        projectPath,
        message: "outside change",
        files: ["../outside.txt"],
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(GitDomainError);
    const response = toHttpError(rejection);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Pathspecs must resolve inside the project root.",
      errorCode: "VALIDATION_FAILED",
      retryable: false,
    });
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});

describe("toHttpError", () => {
  it("maps INVALID_INPUT GitDomainError to 400", async () => {
    const err = new GitDomainError("INVALID_INPUT", "Missing field");
    const response = toHttpError(err);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Missing field");
  });

  it("maps NOT_REPO GitDomainError to 400", async () => {
    const err = new GitDomainError("NOT_REPO", "Not a repo");
    const response = toHttpError(err);
    expect(response.status).toBe(400);
  });

  it("maps AUTH_FAILED GitDomainError to 401", async () => {
    const err = new GitDomainError("AUTH_FAILED", "Auth failed");
    const response = toHttpError(err);
    expect(response.status).toBe(401);
  });

  it("maps SERVICE_BUSY GitDomainError to a retryable 503", async () => {
    const err = new GitDomainError("SERVICE_BUSY", "Try again shortly");
    const response = toHttpError(err);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: "Try again shortly",
      errorCode: "SERVICE_BUSY",
      retryable: true,
    });
  });

  it("maps unknown GitDomainError codes to 500", async () => {
    const err = new GitDomainError("SOME_OTHER", "Other error");
    const response = toHttpError(err);
    expect(response.status).toBe(500);
  });

  it("maps commit message timeout domain code to 504 + typed errorCode", async () => {
    const err = new GitDomainError("COMMIT_MESSAGE_TIMEOUT", "Timed out");
    const response = toHttpError(err);
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe("Timed out");
    expect(body.errorCode).toBe("commit_message_timeout");
  });

  it("delegates non-GitDomainError to classifier", async () => {
    const err = new Error("random failure");
    const response = toHttpError(err);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("random failure");
  });

  it("includes details from classifier when available", async () => {
    const err = new Error("Could not resolve hostname github.com");
    const response = toHttpError(err);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("Could not reach the remote host.");
    expect(body.details).toBe("Verify network access.");
  });
});
