// Records transcripts from the Go reference program that @cfal/noise-ws ships for its own
// interop check (`interop/main.go`, `flynn/noise` v1.1.0 at commit 4d9f71c) into
// `flynn-noise.json`, beside this script. The Rust port replays them in
// `src/noise_ws/tests/vectors.rs`.
//
// Build the reference from the package directory, then run this script with Bun:
//
//   cd <package>/interop && GOMAXPROCS=1 go build -p 1 -o <binary> .
//   bun record_flynn_noise.ts <binary>
//
// The inputs come from a hash stream with fixed labels, so the same transcripts are
// generated every time. The cases follow the package's `scripts/test-interop.ts`: random
// keys and prologues, empty and maximum-length handshake payloads and transport records,
// and two long transcripts whose counters cross 255 and 256 in both directions.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stream = (label: string, length: number) => {
  const bytes = Buffer.alloc(length);
  for (let block = 0; block * 32 < length; block++) {
    createHash('sha256').update(`noise-ws vector ${label} ${block}`).digest().copy(bytes, block * 32);
  }
  return bytes;
};
const sizes = [0, 1, 15, 16, 17, 31, 32, 33, 255, 256, 257, 1024, 65_519];
const cases = Array.from({ length: 20 }, (_, index) => ({
  label: String(index),
  psk: hex(stream(`psk ${index}`, 32)),
  prologue: hex(stream(`prologue ${index}`, index * 53)),
  initiator: hex(stream(`initiator ${index}`, 32)),
  responder: hex(stream(`responder ${index}`, 32)),
  sizes: [
    index === 0 ? 65_487 : index,
    index === 1 ? 65_487 : index * 7,
    ...Array.from({ length: index < 2 ? 520 : sizes.length * 2 }, (_, i) => sizes[i % sizes.length]!),
  ],
}));
const requests = cases.map((item) => JSON.stringify({
  psk: item.psk, prologue: item.prologue, initiator: item.initiator, responder: item.responder,
  payloads: item.sizes.map((size, position) => hex(stream(`payload ${item.label} ${position}`, size))),
}));
const reference = Bun.spawn([process.argv[2]!], { stdin: new Blob([requests.join('\n')]), stdout: 'pipe', stderr: 'pipe' });
const stderr = await new Response(reference.stderr).text();
const output = await new Response(reference.stdout).text();
if (await reference.exited !== 0) throw new Error(stderr);
const answers = output.trim().split('\n').map((line) => JSON.parse(line) as { hash: string; messages: string[] });
const recorded = cases.map((item, index) => ({
  psk: item.psk, prologue: item.prologue, initiator: item.initiator, responder: item.responder,
  sizes: item.sizes,
  // Each ciphertext by length and digest, which is all a file of this size can hold.
  digests: answers[index]!.messages.map((ciphertext) => sha256(Buffer.from(ciphertext, 'hex'))),
  hash: answers[index]!.hash,
}));
await Bun.write(join(import.meta.dir, 'flynn-noise.json'), JSON.stringify({
  reference: 'github.com/flynn/noise v1.1.0, commit 4d9f71cd4ba1fe81415efac312664ccc4bc79b46',
  cases: recorded,
}));
console.log(`${recorded.length} transcripts, ${recorded.reduce((count, item) => count + item.digests.length, 0)} messages`);
