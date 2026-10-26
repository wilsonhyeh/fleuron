import { describe, expect, it } from "vitest";
import { CODE_PALETTE, contrast, luminance, readableOn, textOnSolid, withFamilyColors } from "./code-colors";

const LIGHT_GROUND = "#ffffff";
const DARK_GROUND = "#0f0f0e";
const WHITE = "#ffffff";
const ACCENT = "#8a6410";

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabDistance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe("contrast", () => {
  it("matches known WCAG pairs", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrast("#8a6410", WHITE)).toBeCloseTo(contrast(WHITE, "#8a6410"), 6);
  });

  it("orders by luminance as expected", () => {
    expect(luminance("#ffffff")).toBeGreaterThan(luminance("#8a6410"));
    expect(luminance("#8a6410")).toBeGreaterThan(luminance("#000000"));
  });
});

describe("the palette keeps its stated promise", () => {
  it("every swatch clears 4.5:1 behind white chip text", () => {
    for (const color of CODE_PALETTE) {
      expect(contrast(color, WHITE), `${color} behind white text`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no two swatches read as the same code", () => {
    // OKLab distance. The old scale's closest pair (#1f7a5e / #2d7846) was
    // 0.032 and looked like one green; this keeps every pair well clear of it.
    for (let i = 0; i < CODE_PALETTE.length; i++) {
      for (let j = i + 1; j < CODE_PALETTE.length; j++) {
        expect(
          oklabDistance(CODE_PALETTE[i], CODE_PALETTE[j]),
          `${CODE_PALETTE[i]} vs ${CODE_PALETTE[j]}`,
        ).toBeGreaterThan(0.06);
      }
    }
  });

  it("leaves the UI accent's gold out of the scale", () => {
    for (const color of CODE_PALETTE) {
      expect(oklabDistance(color, ACCENT), color).toBeGreaterThan(0.06);
    }
  });
});

describe("readableOn", () => {
  it("🔴 makes every palette colour legible on the dark ground", () => {
    // The bug this exists for: the palette is tuned for white-on-colour chips,
    // so every entry is dark. Drawn as foreground on a dark background — a
    // highlight rule, the filter banner, the codebook count — they vanished.
    for (const color of CODE_PALETTE) {
      const fixed = readableOn(color, DARK_GROUND);
      expect(
        contrast(fixed, DARK_GROUND),
        `${color} -> ${fixed} on dark`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves a colour alone when it already passes", () => {
    for (const color of CODE_PALETTE) {
      // These were chosen to clear 4.5:1 against a light ground already.
      expect(readableOn(color, LIGHT_GROUND)).toBe(color);
    }
  });

  it("keeps the adjusted colour recognisably the same hue family", () => {
    // Lifting toward white must not turn gold into grey — the colour is how a
    // coder identifies which code a highlight belongs to.
    const gold = readableOn("#8a6410", DARK_GROUND);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(gold.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });

  it("handles shorthand hex and is idempotent", () => {
    const once = readableOn("#333", DARK_GROUND);
    expect(readableOn(once, DARK_GROUND)).toBe(once);
    expect(contrast(once, DARK_GROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it("copes with the extremes without looping forever", () => {
    expect(contrast(readableOn("#000000", DARK_GROUND), DARK_GROUND)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(readableOn("#ffffff", LIGHT_GROUND), LIGHT_GROUND)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("textOnSolid", () => {
  it("clears at least 4.5:1 against every swatch in the default palette", () => {
    for (const color of CODE_PALETTE) {
      const text = textOnSolid(color);
      expect(contrast(text, color), `${text} on ${color}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("handles pure white and pure black fills", () => {
    expect(textOnSolid("#ffffff")).toBe("#000000");
    expect(textOnSolid("#000000")).toBe("#ffffff");
    expect(contrast(textOnSolid("#ffffff"), "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast(textOnSolid("#000000"), "#000000")).toBeCloseTo(21, 1);
  });
});

describe("withFamilyColors", () => {
  const mk = (id: string, parent: string | null, order: number, color: string) => ({
    id,
    name: id,
    definition: null,
    inclusion_criteria: null,
    exclusion_criteria: null,
    example: null,
    parent_id: parent,
    color,
    sort_order: order,
    is_retired: false,
    usage_count: 0,
  });

  it("gives themes palette colours in creation order and sub-codes their theme's", () => {
    const out = withFamilyColors([
      mk("b", null, 1, "#000000"),
      mk("a", null, 0, "#111111"),
      mk("a1", "a", 2, "#222222"),
      mk("b1", "b", 3, "#333333"),
    ]);
    const colour = (id: string) => out.find((c) => c.id === id)?.color;
    expect(colour("a")).toBe(CODE_PALETTE[0]);
    expect(colour("b")).toBe(CODE_PALETTE[1]);
    expect(colour("a1")).toBe(CODE_PALETTE[0]);
    expect(colour("b1")).toBe(CODE_PALETTE[1]);
  });

  it("never mutates the stored colours", () => {
    const input = [mk("a", null, 0, "#111111"), mk("a1", "a", 1, "#222222")];
    withFamilyColors(input);
    expect(input.map((c) => c.color)).toEqual(["#111111", "#222222"]);
  });
});
