export const CLI_PRESET_PRESENTATION_STYLES = ['info', 'notice', 'error'] as const;
export type CliPresetPresentationStyle = (typeof CLI_PRESET_PRESENTATION_STYLES)[number];

export const CLI_PRESENTATION_STYLES = [...CLI_PRESET_PRESENTATION_STYLES, 'custom'] as const;
export type CliPresentationStyle = (typeof CLI_PRESENTATION_STYLES)[number];

export const CLI_PRESENTATION_STYLE_LIST = CLI_PRESENTATION_STYLES.join(', ');

export type HexColor = `#${string}`;

export type CliCustomStyle = {
  readonly lightAccent: HexColor;
  readonly darkAccent: HexColor;
};

export type CliPresentation =
  | { readonly style: CliPresetPresentationStyle }
  | { readonly style: 'custom'; readonly customStyle: CliCustomStyle };

export const CLI_ROW_FORMATS = ['plain', 'markdown'] as const;
export type CliRowFormat = (typeof CLI_ROW_FORMATS)[number];

export const CLI_BODY_DISCLOSURES = ['expanded', 'collapsed'] as const;
export type CliBodyDisclosure = (typeof CLI_BODY_DISCLOSURES)[number];

const normalizedHexColor = /^#[0-9a-f]{6}$/;
const cliHexColorInput = /^#?([0-9a-fA-F]{6})$/;

export function isCliPresentationStyle(value: unknown): value is CliPresentationStyle {
  return (CLI_PRESENTATION_STYLES as readonly unknown[]).includes(value);
}

export function isCliPresetPresentationStyle(value: unknown): value is CliPresetPresentationStyle {
  return (CLI_PRESET_PRESENTATION_STYLES as readonly unknown[]).includes(value);
}

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === 'string' && normalizedHexColor.test(value);
}

export function normalizeCliHexColor(value: string): HexColor | null {
  const match = cliHexColorInput.exec(value);
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

export function isCliCustomStyle(value: unknown): value is CliCustomStyle {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 2
    && isHexColor(value.lightAccent)
    && isHexColor(value.darkAccent);
}

export function isCliPresentation(value: unknown): value is CliPresentation {
  if (!isRecord(value)) return false;
  if (isCliPresetPresentationStyle(value.style)) {
    return Object.keys(value).length === 1;
  }
  return value.style === 'custom'
    && Object.keys(value).length === 2
    && isCliCustomStyle(value.customStyle);
}

export function isCliRowFormat(value: unknown): value is CliRowFormat {
  return (CLI_ROW_FORMATS as readonly unknown[]).includes(value);
}

export function isCliBodyDisclosure(value: unknown): value is CliBodyDisclosure {
  return (CLI_BODY_DISCLOSURES as readonly unknown[]).includes(value);
}

export function coerceDurableCliBodyDisclosure(value: unknown): CliBodyDisclosure {
  return isCliBodyDisclosure(value) ? value : 'expanded';
}

export function coerceDurableCliPresentation(
  value: unknown,
): CliPresentation {
  if (isCliPresentation(value)) return value;
  if (isCliPresentationStyle(value)) {
    return value === 'custom' ? { style: 'notice' } : { style: value };
  }
  if (isRecord(value)) {
    const candidate = {
      style: value.style,
      ...(value.customStyle === undefined ? {} : { customStyle: value.customStyle }),
    };
    if (isCliPresentation(candidate)) return candidate;
  }
  return { style: 'notice' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
