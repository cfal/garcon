if (Bun.version !== "1.4.3") throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const classes = [/\p{L}/u, /\p{N}/u, /\p{M}/u, /\p{Cf}/u, /\p{White_Space}/u];
const masks = new Uint8Array(0x110000);
for (let code = 0; code < masks.length; code++) {
  if (code >= 0xd800 && code <= 0xdfff) continue;
  const character = String.fromCodePoint(code);
  for (let bit = 0; bit < classes.length; bit++) {
    if (classes[bit].test(character)) masks[code] |= 1 << bit;
  }
}
process.stdout.write(masks);
