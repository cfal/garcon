import { describe, expect, it } from 'bun:test';
import { isJsonResponse } from '../response-media-type.ts';

describe('isJsonResponse', () => {
  it('recognizes JSON and structured JSON media types', () => {
    expect(isJsonResponse(Response.json({}))).toBe(true);
    expect(isJsonResponse(new Response('', {
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    }))).toBe(true);
  });

  it('treats SSE and missing content types as streaming responses', () => {
    expect(isJsonResponse(new Response('', {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }))).toBe(false);
    expect(isJsonResponse(new Response(null))).toBe(false);
  });
});
