import { create } from "zustand";

export type MapView = "network" | "timeline" | "structure";

interface MapState {
  /** The map pane is showing beside the transcript. */
  open: boolean;
  /** The map fills the workspace instead of sharing it with the transcript. */
  expanded: boolean;
  view: MapView;
  /** Draw each coded passage as its own dot between the codes it carries. */
  showPassages: boolean;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  setView: (view: MapView) => void;
  setShowPassages: (show: boolean) => void;
}

/**
 * View state only. The map holds no study data of its own: everything it
 * draws is derived on the fly from the project store and the database.
 */
export const useMapStore = create<MapState>((set) => ({
  open: false,
  expanded: false,
  view: "network",
  showPassages: false,
  toggle: () => set((s) => (s.open ? { open: false, expanded: false } : { open: true })),
  setOpen: (open) => set(open ? { open } : { open, expanded: false }),
  setExpanded: (expanded) => set(expanded ? { expanded, open: true } : { expanded }),
  setView: (view) => set({ view }),
  setShowPassages: (showPassages) => set({ showPassages }),
}));
