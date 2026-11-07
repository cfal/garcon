const ORIGINAL_FONT_FACES = new Map([
  ['DepartureMono-1.500.woff2', { family: 'Departure Mono', style: 'normal', weight: '400' }],
  ['JetBrainsMono.woff2', { family: 'JetBrains Mono', style: 'normal', weight: '100 800' }],
  ['JetBrainsMono-Italic.woff2', { family: 'JetBrains Mono', style: 'italic', weight: '100 800' }],
  ['InterVariable.woff2', { family: 'Inter', style: 'normal', weight: '100 900' }],
  ['InterVariable-Italic.woff2', { family: 'Inter', style: 'italic', weight: '100 900' }],
]);

export function originalFontFamily(file: string): string | undefined {
  return ORIGINAL_FONT_FACES.get(file)?.family;
}

export function originalFontCss(
  sources: readonly { file: string }[],
  sourcePath: string,
  familyPrefix = '',
): string {
  const rules: string[] = [];
  for (const { file } of sources) {
    const face = ORIGINAL_FONT_FACES.get(file);
    if (!face) continue;
    rules.push(
      `@font-face {font-family:'${familyPrefix}${face.family}';` +
      `src:url('${sourcePath}/${file}');font-style:${face.style};` +
      `font-weight:${face.weight};font-display:swap;}`,
    );
  }
  return rules.join('\n');
}
