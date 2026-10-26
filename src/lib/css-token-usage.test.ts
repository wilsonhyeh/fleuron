import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `var(--name)` that index.css never defines is not an error anywhere: the
 * declaration just goes invalid. For `border-color` that means the border
 * paints in the text colour, which is how the home-screen study cards and the
 * New interview rows ended up with near-black outlines (`--border` was never
 * a token here). This walks the UI source and fails on any name the
 * stylesheet does not define.
 */

const SRC = path.resolve(__dirname, "..");

/** Set at runtime with style.setProperty or an inline style, not in CSS. */
const RUNTIME_PROPERTIES = new Set(["--rail-l", "--rail-r", "--reading-scale", "--toast-lift"]);

function definedTokens(): Set<string> {
  const css = fs.readFileSync(path.join(SRC, "index.css"), "utf-8");
  return new Set([...css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1]));
}

function uiFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return uiFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

describe("CSS token usage", () => {
  it("every var(--…) in components, hooks and App is defined in index.css", () => {
    const defined = definedTokens();
    const files = [
      ...uiFiles(path.join(SRC, "components")),
      ...uiFiles(path.join(SRC, "hooks")),
      path.join(SRC, "App.tsx"),
    ];
    const undefinedUses: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      for (const match of text.matchAll(/var\((--[a-z][a-z0-9-]*)/g)) {
        const name = match[1];
        if (!defined.has(name) && !RUNTIME_PROPERTIES.has(name)) {
          undefinedUses.push(`${path.relative(SRC, file)}: ${name}`);
        }
      }
    }
    expect(undefinedUses).toEqual([]);
  });
});
