export type ZoomMode = "fit-width" | "manual";

export type StoredViewerState = {
  currentPage: number;
  scrollTop: number;
  scrollLeft: number;
  zoomMode: ZoomMode;
  zoomScale: number;
};

export type PdfPageMetric = {
  width: number;
  height: number;
};

export type PdfZoomAnchor = {
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  anchorOffsetX: number;
  anchorOffsetY: number;
};

export type PdfRenderWindow = {
  start: number;
  end: number;
};

export function readViewerState(storageKey: string): StoredViewerState | null {
  if (typeof window === "undefined" || !storageKey) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(`lithium.pdf.${storageKey}`);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredViewerState>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      currentPage:
        typeof parsed.currentPage === "number" && Number.isFinite(parsed.currentPage)
          ? Math.max(1, parsed.currentPage)
          : 1,
      scrollTop:
        typeof parsed.scrollTop === "number" && Number.isFinite(parsed.scrollTop)
          ? Math.max(0, parsed.scrollTop)
          : 0,
      scrollLeft:
        typeof parsed.scrollLeft === "number" && Number.isFinite(parsed.scrollLeft)
          ? Math.max(0, parsed.scrollLeft)
          : 0,
      zoomMode: parsed.zoomMode === "manual" ? "manual" : "fit-width",
      zoomScale:
        typeof parsed.zoomScale === "number" && Number.isFinite(parsed.zoomScale) ? clampZoom(parsed.zoomScale) : 1
    };
  } catch {
    return null;
  }
}

export function writeViewerState(storageKey: string, state: StoredViewerState) {
  if (typeof window === "undefined" || !storageKey) {
    return;
  }

  try {
    window.localStorage.setItem(`lithium.pdf.${storageKey}`, JSON.stringify(state));
  } catch {
    // Ignore local persistence issues in preview-only state.
  }
}

export function clampZoom(value: number) {
  return Math.min(Math.max(value, 0.4), 3);
}

export function clampRatio(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

export function computeFitWidthScale(availableWidth: number, widestPageWidth: number) {
  return Math.max(0.1, availableWidth / Math.max(widestPageWidth, 1));
}

export function computeRenderWindow(
  metrics: Array<Pick<PdfPageMetric, "height">>,
  scrollTop: number,
  viewportHeight: number,
  currentPage: number,
  gap = 18,
  overscan = 2
): PdfRenderWindow | null {
  if (!metrics.length) {
    return null;
  }

  if (viewportHeight <= 0) {
    const fallbackPage = Math.min(Math.max(currentPage, 1), metrics.length);
    return {
      start: Math.max(1, fallbackPage - overscan),
      end: Math.min(metrics.length, fallbackPage + overscan)
    };
  }

  const viewportTop = Math.max(0, scrollTop);
  const viewportBottom = viewportTop + viewportHeight;
  let cursor = 0;
  let firstVisible = 1;
  let lastVisible = metrics.length;
  let foundVisiblePage = false;

  for (let index = 0; index < metrics.length; index += 1) {
    const pageTop = cursor;
    const pageBottom = pageTop + metrics[index].height;
    const pageNumber = index + 1;

    if (!foundVisiblePage && pageBottom >= viewportTop) {
      firstVisible = pageNumber;
      foundVisiblePage = true;
    }

    if (pageTop <= viewportBottom) {
      lastVisible = pageNumber;
    }

    cursor = pageBottom + gap;
  }

  return {
    start: Math.max(1, firstVisible - overscan),
    end: Math.min(metrics.length, lastVisible + overscan)
  };
}

export function buildRenderOrder(window: PdfRenderWindow, pivot: number) {
  const order: number[] = [];
  const clampedPivot = Math.min(Math.max(pivot, window.start), window.end);

  for (let distance = 0; distance <= window.end - window.start; distance += 1) {
    const forward = clampedPivot + distance;
    const backward = clampedPivot - distance;

    if (distance === 0) {
      order.push(clampedPivot);
      continue;
    }

    if (forward <= window.end) {
      order.push(forward);
    }

    if (backward >= window.start) {
      order.push(backward);
    }
  }

  return order;
}
