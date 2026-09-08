function relativeLuminance(rgb: string): number {
  const values = rgb.match(/[\d.]+/g)?.map(Number);
  if (!values || values.length < 3) {
    throw new Error(`Unsupported color: ${rgb}`);
  }
  const alpha = values[3] ?? 1;
  if (alpha !== 1) throw new Error(`Color must be opaque: ${rgb}`);
  const channels = values.slice(0, 3);

  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}
