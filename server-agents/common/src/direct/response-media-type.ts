export function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();

  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}
