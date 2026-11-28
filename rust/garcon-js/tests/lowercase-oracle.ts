if (Bun.version !== "1.4.3") throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const contexts = new Uint8Array(0x110000);
const changed: [number, string][] = [];
const finalSigma = "\u03c2";
for (let code = 0; code < contexts.length; code++) {
  if (code >= 0xd800 && code <= 0xdfff) continue;
  const character = String.fromCodePoint(code);
  const lowercase = character.toLowerCase();
  if (lowercase !== character) changed.push([code, lowercase]);
  contexts[code] = Number(`A\u03a3${character}`.toLowerCase()[1] === finalSigma)
    | (Number(`A\u03a3${character}A`.toLowerCase()[1] === finalSigma) << 1)
    | (Number(`${character}\u03a3`.toLowerCase().endsWith(finalSigma)) << 2)
    | (Number(`A${character}\u03a3`.toLowerCase().endsWith(finalSigma)) << 3);
}
process.stdout.write(contexts);
process.stdout.write(JSON.stringify(changed));
