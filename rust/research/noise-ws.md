# Noise WebSockets

## Where the original uses it

- `server/controller/server.ts:825-827` shares the Noise acceptor on the
  controller's HTTP listener. `server/controller/ws/upgrade.ts:27-33`
  routes executor sockets separately from browser sockets.
- `server/remote/transport/websocket-link.ts:181-205,245-305` mounts
  the listener, owns admission, and dials independently of which side
  is the worker. Primary and bulk policy is Garcon's, not the library's.
- `bun.lock:56,427` pins `@cfal/noise-ws 0.1.0` at
  `6cf4a4b2ab25d300316a21c23cbcef1bb3558556`.

## Behavior the port must keep

- The dialer is the Noise initiator. The fixed pattern is
  `Noise_NNpsk0_25519_AESGCM_SHA256`; WS or outer TLS never replaces it.
  Match the application context prologue byte for byte. The package
  builds it from a fixed prefix, version, UTF-8 byte count, and context
  (`src/options.ts`).
- The WebSocket upgrading is not authenticated readiness. The socket
  adapter uses empty Noise handshake payloads, then exchanges encrypted
  confirmation records. Only then allow live messages.
- `src/options.ts` and `src/records.ts` distinguish a 65,535-byte
  encrypted record from a 16 MiB reassembled message. Keep exact
  fragment lengths, text versus binary distinction, fatal UTF-8 text
  decoding with BOM retained, and one complete-message delivery.
  Bound outstanding bytes, handshakes and inbound message assembly.
- Maintain an independent nonce counter for each direction; its wire
  convention for AES-GCM is a 96-bit nonce with the counter in the
  final eight bytes, big-endian (`src/cipher.ts`). Do not retry a write
  the transport accepted under backpressure.
- Only a peer's authenticated encrypted close record sets
  `authenticated`; WebSocket close is not that record, and encrypted
  close is not a receipt. A disconnected session is not replayable.
  Garcon owns reconnect continuity above the link.

## Rust implementation

The [MAP](../MAP.md) selects the fixed protocol over existing primitive
implementations in RustCrypto: X25519, AES-256-GCM, SHA-256/HKDF, and OS
randomness. A primitive-only scratch probe passed on Rust 1.99.1 with
`x25519-dalek 2.0.1` (`static_secrets` plus defaults), `aes-gcm 0.10.3`,
`hkdf 0.12.4`, and `sha2 0.10.9` (defaults). These are compile-checked
candidates, not a dependency pin for `garcon-link`. Socket framing,
readiness and lifecycle still need the package vectors and bidirectional
native interop; neither was run against a Rust link in this research.

## Traps

The package's original Bun vector test passed on 1.4.3. The input is the
independent public Cacophony vector in `test/fixtures/cacophony.json`,
with synthetic keys and two nonempty handshake payloads. Both peers
report the handshake hash
`9f3b1f9afd7767767b5b9d1069844a6154fdbdcc36dfb3e31c0fffc5c973d530`.
The first transport payload `F. A. Hayek` is encrypted as
`7c01e898a6201f36aecee532e29cd0b7f8ffa29d3366ad0dce39a6`;
all directional ciphertext and decryption expectations passed, 15
assertions in the test. This exercises the primitive handshake,
which accepts the vector payloads; Garcon's socket-level handshake opts
out of them and requires confirmation records.

## Sources

- Installed `server/node_modules/@cfal/noise-ws/src/{options,handshake,cipher,records,connection}.ts`,
  `test/vectors.test.ts`, and `interop/README.md`. The Go interop runner
  tests 20 bidirectional transcripts against `flynn/noise v1.1.0`;
  it was not rerun for this note.
- [Noise protocol specification](https://noiseprotocol.org/noise.html);
  [x25519-dalek](https://docs.rs/x25519-dalek/2.0.1/x25519_dalek/),
  [aes-gcm](https://docs.rs/aes-gcm/0.10.3/aes_gcm/),
  [hkdf](https://docs.rs/hkdf/0.12.4/hkdf/),
  and [sha2](https://docs.rs/sha2/0.10.9/sha2/).
