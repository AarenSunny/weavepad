import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test("small muted text tokens meet WCAG AA contrast on every declared surface", async () => {
  const stylesheet = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  const color = (name: string): string => {
    const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(stylesheet);
    assert.ok(match, `missing ${name} color token`);
    return match[1];
  };

  const mutedText = color("--text-muted");
  const mutedSurfaces = [
    "--surface",
    "--surface-muted",
    "--surface-selected",
    "--surface-pill",
    "--surface-note",
    "--surface-hover",
  ];
  for (const surface of mutedSurfaces) {
    assert.ok(
      contrastRatio(mutedText, color(surface)) >= 4.5,
      `${surface} must provide 4.5:1 contrast for small muted text`,
    );
  }
  assert.ok(contrastRatio(color("--text-eyebrow"), color("--surface")) >= 4.5);
});
