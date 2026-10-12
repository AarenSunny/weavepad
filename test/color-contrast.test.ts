import assert from "node:assert/strict";
import { test } from "node:test";
import { AVATAR_COLORS, avatarTextColor, contrastRatio } from "../web/color-contrast.ts";

test("avatar initials choose an AA-contrast foreground for every generated color", () => {
  for (const background of AVATAR_COLORS) {
    const foreground = avatarTextColor(background);
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${foreground} must remain readable on ${background}`,
    );
  }
});

test("dynamic avatar colors choose the higher-contrast safe foreground", () => {
  assert.equal(avatarTextColor("#000000"), "#FFFFFF");
  assert.equal(avatarTextColor("#FFFFFF"), "#000000");
  assert.equal(avatarTextColor("#777777"), "#000000");
  assert.equal(avatarTextColor("invalid"), "#000000");
});
