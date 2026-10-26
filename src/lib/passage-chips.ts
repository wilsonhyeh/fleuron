import type { Code, CodedSegment } from "./types";

/**
 * Code chips under a passage: one chip per code per coder, not one group per
 * coding. Two spans of the same passage both coded "Waiting list" used to
 * show the chip twice with nothing tying either chip to its span.
 */
export interface PassageChip {
  code: Code;
  /** Every coding by this coder on this passage that carries the code, in text order. */
  codings: CodedSegment[];
}

export interface PassageChipGroup {
  coder: string;
  theirs: boolean;
  chips: PassageChip[];
}

/** Text order: whole-passage codings first, then spans by where they start. */
function byPosition(a: CodedSegment, b: CodedSegment): number {
  return (a.char_start ?? -1) - (b.char_start ?? -1) || (a.char_end ?? -1) - (b.char_end ?? -1);
}

/** The active coder's chips first, then each other coder in the order they appear. */
export function groupPassageChips(
  codings: readonly CodedSegment[],
  activeCoder: string,
  codesById: Map<string, Code>,
): PassageChipGroup[] {
  const sorted = [...codings].sort(byPosition);
  const groups = new Map<string, Map<string, PassageChip>>();
  for (const coding of sorted) {
    const chips = groups.get(coding.coder_name) ?? new Map<string, PassageChip>();
    groups.set(coding.coder_name, chips);
    for (const id of coding.code_ids) {
      const code = codesById.get(id);
      if (!code) continue;
      const chip = chips.get(id);
      if (chip) chip.codings.push(coding);
      else chips.set(id, { code, codings: [coding] });
    }
  }
  const out = [...groups].map(([coder, chips]) => ({
    coder,
    theirs: coder !== activeCoder,
    chips: [...chips.values()],
  }));
  return out.filter((g) => g.chips.length > 0).sort((a, b) => Number(a.theirs) - Number(b.theirs));
}

/**
 * The coding a click on a chip should open: the one after the coding this
 * chip opened last, wrapping, or the first. Keyed on what the chip opened, not
 * on the live selection: pressing the chip closes the bubble, which clears the
 * selection before the click lands.
 */
export function nextCoding(
  codings: readonly CodedSegment[],
  lastOpenedId: string | null,
): CodedSegment {
  const last = codings.findIndex((c) => c.id === lastOpenedId);
  return codings[(last + 1) % codings.length];
}
