# Direct provider HTTP

The reference is Bun 1.4.3 `fetch` against local fake providers and proxies. No
requests went to a real provider. The worker's direct runtimes use one reqwest
client with default features disabled and the ring-backed TLS configuration
shared with the executor link.

## Request and response

- The method, request target and JSON body bytes are compared against the
  original for Chat Completions, Responses and Anthropic Messages. Header
  names are normalized for comparison: reqwest does not reproduce Bun's
  header-name casing or order, which are immaterial under HTTP. The field set
  and values must match verbatim, except for the User-Agent value below.
- Bun sent `User-Agent: Bun/1.4.3`, `Accept: */*`,
  `Accept-Encoding: gzip, deflate, br, zstd`, and `Connection: keep-alive`.
  The port sends the same Accept, Accept-Encoding and Connection fields and
  decodes each advertised codec on SSE bodies.
- A TLS fixture that offered `h2` before `http/1.1` negotiated `http/1.1`.
  The port uses HTTP/1.1 only.

## Trust and proxies

- A private issuer failed verification without additional trust. Its CA
  worked independently from `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and an
  OpenSSL-hashed `SSL_CERT_DIR`. These sources augment the bundled roots;
  reqwest does not choose its own platform trust defaults.
- `HTTP_PROXY` applies to HTTP and `HTTPS_PROXY` to HTTPS; `ALL_PROXY` is the
  fallback. A nonempty lowercase variable wins over its uppercase counterpart;
  an empty lowercase value falls through. `REQUEST_METHOD` did not disable
  `HTTP_PROXY`. HTTP uses an absolute request target; HTTPS uses `CONNECT`.
- `NO_PROXY` and `no_proxy` use the same precedence. Bun honored exact hosts,
  a matching host and port, `*`, and IPv4 CIDR. A different port did not bypass
  the proxy.

## Differences from the original, decided

ADR-031 changes two provider-facing behaviors:

- **User agent.** The port identifies itself as `Garcon/<version>`, using
  the build's workspace package version without extra tokens.
- **Redirects.** Bun followed a cross-origin 307 with the original POST body,
  dropping Bearer `Authorization` but forwarding `x-api-key`. The port refuses
  any redirect that changes scheme, host or port, including on a later hop.
  It reports a non-retryable provider failure naming only the two origins.
  Same-origin redirects still follow normal HTTP redirect behavior.
