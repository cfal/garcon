import { describe, it, expect } from 'bun:test';
import { GitDomainError } from '../../git/git-types.js';
import { ProjectBoundaryError } from '../../lib/path-boundary.js';
import { gitErrorResponse } from '../git-http-error.js';

describe("Git HTTP errors", () => {
  it("maps INVALID_INPUT GitDomainError to 400", async () => {
    const err = new GitDomainError("INVALID_INPUT", "Missing field");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Missing field");
  });

  it("maps NOT_REPO GitDomainError to 400", async () => {
    const err = new GitDomainError("NOT_REPO", "Not a repo");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(400);
  });

  it("maps AUTH_FAILED GitDomainError to 401", async () => {
    const err = new GitDomainError("AUTH_FAILED", "Auth failed");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(401);
  });

  it("maps SERVICE_BUSY GitDomainError to a retryable 503", async () => {
    const err = new GitDomainError("SERVICE_BUSY", "Try again shortly");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Try again shortly",
      errorCode: "SERVICE_BUSY",
      retryable: true,
    });
  });

  it("maps unknown GitDomainError codes to 500", async () => {
    const err = new GitDomainError("SOME_OTHER", "Other error");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(500);
  });

  it("maps commit message timeout domain code to 504 + typed errorCode", async () => {
    const err = new GitDomainError("COMMIT_MESSAGE_TIMEOUT", "Timed out");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe("Timed out");
    expect(body.errorCode).toBe("commit_message_timeout");
  });

  it("delegates non-GitDomainError to classifier", async () => {
    const err = new Error("random failure");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("random failure");
  });

  it("includes details from classifier when available", async () => {
    const err = new Error("Could not resolve hostname github.com");
    const response = gitErrorResponse(err);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("Could not reach the remote host.");
    expect(body.details).toBe("Verify network access and remote URL.");
  });
});

it('maps owner path refusal to the unchanged boundary response', async () => {
  const response = gitErrorResponse(new ProjectBoundaryError());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    success: false,
    retryable: false,
    error: 'Path is outside the allowed base directory',
    errorCode: 'outside_project_base',
  });
});
