import { describe, expect, it } from "vitest";
import { wrapLines } from "./wrap-lines";

describe("wrapLines", () => {
  it("keeps a short title on one line", () => {
    expect(wrapLines("Pilot study", 15, 3)).toEqual(["Pilot study"]);
  });

  it("wraps a long title by word", () => {
    expect(wrapLines("Belonging in Shared Garden Plots", 15, 3)).toEqual([
      "Belonging in",
      "Shared Garden",
      "Plots",
    ]);
  });

  it("ellipses the last line when words are left over", () => {
    const lines = wrapLines("one two three four five six seven eight nine ten", 9, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines.every((l) => l.length <= 9)).toBe(true);
  });

  it("ellipses a single word longer than the width", () => {
    expect(wrapLines("Supercalifragilistic", 10, 3)).toEqual(["Supercali…"]);
  });

  it("returns nothing for an empty title", () => {
    expect(wrapLines("   ", 15, 3)).toEqual([]);
  });
});
