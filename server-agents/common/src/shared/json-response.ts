// Reads a fetch response's JSON body. A parse error's message can echo the
// body, so the error names the response's source instead.
export async function readJsonResponse(response: Response, source: string): Promise<unknown> {
  const body = await response.text();
  try { return JSON.parse(body); }
  catch { throw new Error(`${source} response is not valid JSON.`); }
}
