export interface PlacementRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface NotePlacementInput {
  rowRect: PlacementRect;
  scrollerRect: PlacementRect;
  cardHeight: number;
  cardWidth?: number;
  viewportHeight?: number;
  viewportWidth?: number;
}

export interface NotePlacementOutput {
  top: number;
  left: number;
  placement: "beside" | "below";
}

export const NOTE_CARD_WIDTH = 300;
export const NOTE_CARD_GUTTER_MARGIN = 16;
export const NOTE_CARD_VIEWPORT_PADDING = 8;
export const MIN_READING_COLUMN_BESIDE = 560;

/**
 * Computes placement for note cards beside or below a passage row.
 * Default: place in the right gutter of the reading page (scroller.right - 316),
 * vertically centered on the row, clamped to viewport.
 * If reading column is narrower than 560px or would overlap the text rect, place below the row.
 */
export function computeNotePlacement({
  rowRect,
  scrollerRect,
  cardHeight,
  cardWidth = NOTE_CARD_WIDTH,
  viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800,
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200,
}: NotePlacementInput): NotePlacementOutput {
  // Keep the card inside the transcript area: a pinned note whose passage has
  // scrolled away used to stick to the window edge, over the toolbar.
  const minTop = Math.max(NOTE_CARD_VIEWPORT_PADDING, scrollerRect.top + NOTE_CARD_VIEWPORT_PADDING);
  const maxTop = Math.max(
    minTop,
    Math.min(viewportHeight, scrollerRect.bottom) - cardHeight - NOTE_CARD_VIEWPORT_PADDING,
  );
  const clampTop = (top: number) => Math.max(minTop, Math.min(maxTop, top));

  const isNarrow = scrollerRect.width < MIN_READING_COLUMN_BESIDE;
  const besideLeft = scrollerRect.right - (cardWidth + NOTE_CARD_GUTTER_MARGIN);

  // If column is narrower than 560px or beside placement would overlap row text rect
  const wouldOverlapRow =
    besideLeft < rowRect.right && besideLeft + cardWidth > rowRect.left;

  if (isNarrow || wouldOverlapRow) {
    // Below the row instead of beside it. Never place over the row's text rect.
    const top = clampTop(rowRect.bottom + 8);
    const left = Math.max(
      NOTE_CARD_VIEWPORT_PADDING,
      Math.min(
        viewportWidth - cardWidth - NOTE_CARD_VIEWPORT_PADDING,
        rowRect.left,
      ),
    );
    return {
      top,
      left,
      placement: "below",
    };
  }

  // Default: beside in the right gutter, vertically centered on row
  const top = clampTop(rowRect.top + rowRect.height / 2 - cardHeight / 2);
  const left = Math.max(
    NOTE_CARD_VIEWPORT_PADDING,
    Math.min(
      viewportWidth - cardWidth - NOTE_CARD_VIEWPORT_PADDING,
      besideLeft,
    ),
  );

  return {
    top,
    left,
    placement: "beside",
  };
}
