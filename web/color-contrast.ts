const DARK_TEXT = "#000000";
const LIGHT_TEXT = "#FFFFFF";

export const AVATAR_COLORS = ["#7C3AED", "#0891B2", "#EA580C", "#16A34A", "#DB2777", "#4F46E5"];

function luminance(hex: string): number | null {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return 1;
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

export function avatarTextColor(background: string): typeof DARK_TEXT | typeof LIGHT_TEXT {
  if (luminance(background) === null) return DARK_TEXT;
  return contrastRatio(LIGHT_TEXT, background) >= contrastRatio(DARK_TEXT, background)
    ? LIGHT_TEXT
    : DARK_TEXT;
}
