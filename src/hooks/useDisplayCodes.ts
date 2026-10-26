import { useMemo } from "react";
import { withFamilyColors } from "../lib/code-colors";
import type { Code } from "../lib/types";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";

/** Whether family colours are on. Absent from older preference files = on. */
export function familyColorsOn(): boolean {
  return useAppStore.getState().preferences.family_colors !== false;
}

/** The codes as they should be drawn: family colours applied when on. */
export function displayCodes<T extends Code>(codes: readonly T[], family: boolean): T[] {
  return family ? withFamilyColors(codes) : [...codes];
}

/**
 * The live codebook with display colours. Anything that *draws* a code reads
 * this; anything that *saves* a code reads the store, so a derived colour can
 * never be written back over the one the researcher chose.
 */
export function useDisplayCodes(): Code[] {
  const codes = useProjectStore((s) => s.codes);
  const family = useAppStore((s) => s.preferences.family_colors !== false);
  return useMemo(() => displayCodes(codes, family), [codes, family]);
}
