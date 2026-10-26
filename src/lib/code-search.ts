import type { Code } from "./types";

/**
 * Codebook search predicate (T07).
 *
 * Matches a word in the code's name or any of its descriptive text —
 * definition, inclusion/exclusion criteria, example — not just the name. A
 * code named "Trust" with "asks who holds the notes" only in its definition
 * must still surface. Case-insensitive; a blank query matches everything.
 */
export function codeMatchesQuery(code: Code, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const haystacks = [
    code.name,
    code.definition,
    code.inclusion_criteria,
    code.exclusion_criteria,
    code.example,
  ];
  return haystacks.some(
    (field) => field != null && field.toLowerCase().includes(q),
  );
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Codebook name order. Numeric, so "Concept 2" sorts before "Concept 10";
 * plain localeCompare gave 1, 10, 11, 2 for numbered codes.
 */
export function compareCodeNames(a: Pick<Code, "name">, b: Pick<Code, "name">): number {
  return nameCollator.compare(a.name, b.name);
}

/** Passages with the code or any live sub-code, each counted once. Computed by
 *  the backend across the whole study; `usage_count` when it is absent. */
export function rollupCount(code: Pick<Code, "usage_count" | "rollup_count">): number {
  return code.rollup_count ?? code.usage_count;
}

/**
 * The code ids a filter on `codeId` matches: the code and its live sub-codes.
 * A sub-code never requires its parent on the passage, so filtering by a
 * parent has to reach passages coded only with a sub-code.
 */
export function codeWithSubCodes(codeId: string, codes: Code[]): Set<string> {
  const ids = new Set([codeId]);
  for (const c of codes) {
    if (c.parent_id === codeId && !c.is_retired) ids.add(c.id);
  }
  return ids;
}

/**
 * The codebook's own order: top-level codes by name, each followed by its
 * sub-codes by name. The codebook panel's default view and the coding bubble's
 * ⌘1–⌘9 both read it, so a shortcut names the same code as the Nth row of the
 * codebook and does not move as codes are used.
 */
export function codebookOrder(codes: readonly Code[]): Code[] {
  const out: Code[] = [];
  for (const parent of codes.filter((c) => !c.parent_id).sort(compareCodeNames)) {
    out.push(parent, ...codes.filter((c) => c.parent_id === parent.id).sort(compareCodeNames));
  }
  const seen = new Set(out.map((c) => c.id));
  return [...out, ...codes.filter((c) => !seen.has(c.id))];
}
