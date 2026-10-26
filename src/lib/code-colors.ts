import type { Code } from "./types";

/**
 * Code swatch palette.
 *
 * These are **data colours, not theme colours.** The app's chrome is grey and
 * gold; codes are a categorical scale and their whole job is to be told apart.
 * So the scale leaves the accent's hue out entirely: a gold code chip read as
 * the Export button, and a gold underline read as UI rather than data.
 *
 * 🔑 Every value clears **4.5:1 against the white chip text**, and the hues are
 * spaced in OKLab so the closest pair (blue / indigo) is twice as far apart as
 * the old 16-swatch scale's closest pair (two greens that read as one code).
 * Nine distinct colours that repeat beat sixteen where five are near-copies.
 *
 * The order is the order codes are created in, so neighbours in the list are
 * the most different from each other.
 */
export const CODE_PALETTE = [
  "#3578b8", // blue
  "#c34f4d", // red
  "#448247", // green
  "#9260b0", // violet
  "#b25e22", // orange
  "#00837e", // teal
  "#b55386", // rose
  "#676dc2", // indigo
  "#6a7683", // slate
] as const;

/**
 * Family colours: every theme (top-level code) takes the next palette colour
 * in the order the themes were made, and every sub-code wears its theme's.
 *
 * Applied for display only. The stored colour on each code is never touched,
 * so turning the setting off brings back exactly the colours that were
 * chosen by hand, and nothing that saves a code can write a derived colour.
 * Creation order (sort_order), not name order: adding a theme must not
 * repaint the themes that already exist.
 */
export function withFamilyColors<T extends Code>(codes: readonly T[]): T[] {
  const byId = new Map(codes.map((c) => [c.id, c]));
  const rootOf = (code: T): T => {
    let current = code;
    const seen = new Set<string>();
    while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parent_id)!;
    }
    return current;
  };
  const themes = codes
    .filter((c) => rootOf(c) === c)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const themeColor = new Map(themes.map((t, i) => [t.id, CODE_PALETTE[i % CODE_PALETTE.length]]));
  return codes.map((c) => {
    const color = themeColor.get(rootOf(c).id) ?? c.color;
    return color === c.color ? c : { ...c, color };
  });
}

/** Next colour for a codebook that already holds `count` codes. */
export function nextCodeColor(count: number): string {
  return CODE_PALETTE[count % CODE_PALETTE.length];
}

// ── Making a code colour usable against either theme ─────────────────────────
//
// The palette above is tuned for one job: a chip background behind white text.
// That forces every entry dark. Used the other way round — as *foreground*, or
// as a rule under highlighted text on a dark ground — those same values are
// nearly invisible, and in dark mode a dark code colour on a dark background is
// simply unreadable.
//
// So a code has one stored colour and two presentations, and which one applies
// depends on the theme rather than on the code.

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

/**
 * A version of `color` that stays legible as foreground against `background`.
 *
 * Blends toward the background's opposite in small steps until the pair clears
 * 4.5:1, rather than applying a fixed lightening — the palette spans a range of
 * luminances, so one fixed amount would over-correct some entries and leave
 * others unreadable. Returns the original when it already passes, which is the
 * usual case in light mode.
 */
export function readableOn(color: string, background: string): string {
  if (contrast(color, background) >= 4.5) return color;

  const target = luminance(background) > 0.5 ? "#000000" : "#ffffff";
  for (let amount = 0.1; amount <= 1; amount += 0.1) {
    const candidate = mix(color, target, amount);
    if (contrast(candidate, background) >= 4.5) return candidate;
  }
  return target;
}

/**
 * Pick white or black text to guarantee legibility when drawn directly over a solid fill.
 * Returns a candidate meeting 4.5:1, choosing the higher ratio if both or neither pass.
 */
export function textOnSolid(fill: string): string {
  const whiteContrast = contrast("#ffffff", fill);
  const blackContrast = contrast("#000000", fill);
  const whitePasses = whiteContrast >= 4.5;
  const blackPasses = blackContrast >= 4.5;

  if (whitePasses && !blackPasses) return "#ffffff";
  if (blackPasses && !whitePasses) return "#000000";
  return whiteContrast >= blackContrast ? "#ffffff" : "#000000";
}
