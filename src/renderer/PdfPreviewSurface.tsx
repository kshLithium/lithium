import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { ResolvedTheme } from "../shared/types";
import {
  buildRenderOrder,
  clampRatio,
  clampZoom,
  computeRenderWindow,
  computeFitWidthScale,
  readViewerState,
  type StoredViewerState,
  type PdfPageMetric,
  type PdfZoomAnchor,
  type ZoomMode,
  writeViewerState
} from "./pdf-preview/model";

GlobalWorkerOptions.workerSrc = workerUrl;

type PdfPreviewSurfaceProps = {
  data: Uint8Array;
  storageKey: string;
  themeMode: ResolvedTheme;
  jumpTarget?: {
    pageNumber: number;
    yRatio: number | null;
  } | null;
  jumpNonce?: number;
  onNavigateSource?: (target: { pageNumber: number; yRatio: number }) => void;
};

const PAGE_VIEWPORT_GUTTER = 6;
const PAGE_TRACK_GAP = 12;

export function PdfPreviewSurface(props: PdfPreviewSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pageFrameRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pageVisibilityRef = useRef<Map<number, number>>(new Map());
  const restoredScrollRef = useRef(false);
  const zoomAnchorRef = useRef<PdfZoomAnchor | null>(null);
  const pointerPositionRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const textLayerInstancesRef = useRef<Map<number, TextLayer>>(new Map());
  const textLayerScaleRef = useRef<Map<number, number>>(new Map());
  const zoomAnimationFrameRef = useRef<number | null>(null);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const viewerStateTimerRef = useRef<number | null>(null);
  const pendingViewerStateRef = useRef<{ storageKey: string; state: StoredViewerState } | null>(null);
  const lastPersistedViewerStateRef = useRef<{ storageKey: string; serialized: string } | null>(null);
  const appliedJumpNonceRef = useRef<number | null>(null);
  const currentVisualScaleRef = useRef(1);
  const currentPageRef = useRef(1);
  const renderedScaleRef = useRef<Map<number, number>>(new Map());
  const [pageCount, setPageCount] = useState(0);
  const [pageMetrics, setPageMetrics] = useState<PdfPageMetric[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-width");
  const [zoomScale, setZoomScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [renderingPages, setRenderingPages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const widestPageWidth = useMemo(
    () => pageMetrics.reduce((maxWidth, metric) => Math.max(maxWidth, metric.width), 0),
    [pageMetrics]
  );

  const renderScale = useMemo(
    () =>
      zoomMode === "fit-width"
        ? widestPageWidth > 0
          ? computeFitWidthScale(containerWidth - PAGE_VIEWPORT_GUTTER, widestPageWidth)
          : 1
        : zoomScale,
    [containerWidth, widestPageWidth, zoomMode, zoomScale]
  );

  const renderedPageMetrics = useMemo(
    () =>
      pageMetrics.map((metric) => ({
        width: metric.width * renderScale,
        height: metric.height * renderScale
      })),
    [pageMetrics, renderScale]
  );

  const maxRenderedPageWidth = useMemo(
    () => renderedPageMetrics.reduce((maxWidth, metric) => Math.max(maxWidth, metric.width), 0),
    [renderedPageMetrics]
  );

  const pageTrackStyle = useMemo(
    () => (maxRenderedPageWidth > 0 ? { width: `${maxRenderedPageWidth}px` } : undefined),
    [maxRenderedPageWidth]
  );

  const renderWindow = useMemo(
    () => computeRenderWindow(renderedPageMetrics, scrollTop, containerHeight, currentPage, PAGE_TRACK_GAP),
    [containerHeight, currentPage, renderedPageMetrics, scrollTop]
  );

  function flushPendingViewerState() {
    if (viewerStateTimerRef.current != null) {
      window.clearTimeout(viewerStateTimerRef.current);
      viewerStateTimerRef.current = null;
    }

    const pending = pendingViewerStateRef.current;

    if (!pending) {
      return;
    }

    pendingViewerStateRef.current = null;
    const serialized = JSON.stringify(pending.state);
    const previous = lastPersistedViewerStateRef.current;

    if (previous?.storageKey === pending.storageKey && previous.serialized === serialized) {
      return;
    }

    writeViewerState(pending.storageKey, pending.state);
    lastPersistedViewerStateRef.current = {
      storageKey: pending.storageKey,
      serialized
    };
  }

  function queueViewerStateWrite(storageKey: string, state: StoredViewerState) {
    pendingViewerStateRef.current = {
      storageKey,
      state
    };

    if (viewerStateTimerRef.current != null) {
      return;
    }

    viewerStateTimerRef.current = window.setTimeout(() => {
      flushPendingViewerState();
    }, 120);
  }

  useEffect(() => {
    currentVisualScaleRef.current = renderScale;
  }, [renderScale]);

  useEffect(() => {
    return () => {
      flushPendingViewerState();
    };
  }, []);

  useEffect(() => {
    flushPendingViewerState();
    const savedState = readViewerState(props.storageKey);

    if (savedState) {
      setZoomMode(savedState.zoomMode);
      setZoomScale(savedState.zoomScale);
    } else {
      setZoomMode("fit-width");
      setZoomScale(1);
    }

    appliedJumpNonceRef.current = null;
    restoredScrollRef.current = false;
  }, [props.storageKey]);

  useEffect(() => {
    const node = containerRef.current;

    if (!node) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? 0;
      const nextHeight = entries[0]?.contentRect.height ?? 0;
      setContainerWidth(nextWidth);
      setContainerHeight(nextHeight);
    });

    observer.observe(node);
    const rect = node.getBoundingClientRect();
    setContainerWidth(rect.width);
    setContainerHeight(rect.height);
    setScrollTop(node.scrollTop);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadDocument = async () => {
      setDocumentLoading(true);
      setRenderingPages(false);
      setError(null);
      setPageCount(0);
      setPageMetrics([]);
      setCurrentPage(1);
      currentPageRef.current = 1;

      try {
        const loadingTask = getDocument({ data: props.data });
        loadingTaskRef.current = loadingTask;
        const pdf = await loadingTask.promise;

        if (cancelled) {
          await pdf.destroy();
          return;
        }

        const metrics: PdfPageMetric[] = [];

        for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
          const page = await pdf.getPage(pageIndex);
          const viewport = page.getViewport({ scale: 1 });
          metrics.push({
            width: viewport.width,
            height: viewport.height
          });
        }

        if (cancelled) {
          await pdf.destroy();
          return;
        }

        pdfRef.current = pdf;
        canvasRefs.current = [];
        textLayerRefs.current = [];
        pageFrameRefs.current = [];
        pageVisibilityRef.current.clear();
        renderedScaleRef.current.clear();
        textLayerScaleRef.current.clear();
        for (const textLayer of textLayerInstancesRef.current.values()) {
          textLayer.cancel();
        }
        textLayerInstancesRef.current.clear();
        setPageMetrics(metrics);
        setPageCount(pdf.numPages);
      } catch (nextError) {
        if (!cancelled && !isExpectedPdfAbort(nextError)) {
          pdfRef.current = null;
          canvasRefs.current = [];
          textLayerRefs.current = [];
          pageFrameRefs.current = [];
          pageVisibilityRef.current.clear();
          renderedScaleRef.current.clear();
          textLayerScaleRef.current.clear();
          for (const textLayer of textLayerInstancesRef.current.values()) {
            textLayer.cancel();
          }
          textLayerInstancesRef.current.clear();
          setPageMetrics([]);
          setPageCount(0);
          setCurrentPage(1);
          currentPageRef.current = 1;
          setError(nextError instanceof Error ? nextError.message : "Failed to load PDF preview.");
        }
      } finally {
        if (!cancelled) {
          setDocumentLoading(false);
        }
      }
    };

    void loadDocument();

    return () => {
      cancelled = true;
      const loadingTask = loadingTaskRef.current;
      loadingTaskRef.current = null;
      const pdf = pdfRef.current;
      pdfRef.current = null;
      renderedScaleRef.current.clear();
      textLayerScaleRef.current.clear();
      for (const textLayer of textLayerInstancesRef.current.values()) {
        textLayer.cancel();
      }
      textLayerInstancesRef.current.clear();
      void loadingTask?.destroy();
      void pdf?.destroy();
    };
  }, [props.data]);

  useEffect(() => {
    const pdf = pdfRef.current;

    if (!pdf || !pageCount || !pageMetrics.length || !renderScale || !renderWindow) {
      return;
    }

    let cancelled = false;
    const activeTasks: RenderTask[] = [];
    const targetPages = buildRenderOrder(renderWindow, currentPage);

    const renderVisiblePages = async () => {
      const targetSet = new Set(targetPages);

      for (let pageIndex = 0; pageIndex < canvasRefs.current.length; pageIndex += 1) {
        const pageNumber = pageIndex + 1;

        if (targetSet.has(pageNumber)) {
          continue;
        }

        renderedScaleRef.current.delete(pageNumber);
        textLayerScaleRef.current.delete(pageNumber);
        const textLayer = textLayerInstancesRef.current.get(pageNumber);
        textLayer?.cancel();
        textLayerInstancesRef.current.delete(pageNumber);
        const canvas = canvasRefs.current[pageIndex];
        const context = canvas?.getContext("2d");
        const textLayerHost = textLayerRefs.current[pageIndex];

        if (canvas && context) {
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, canvas.width, canvas.height);
          canvas.width = 0;
          canvas.height = 0;
        }

        textLayerHost?.replaceChildren();
      }

      const pagesNeedingRender = targetPages.filter((pageNumber) => {
        const metric = renderedPageMetrics[pageNumber - 1];
        const canvas = canvasRefs.current[pageNumber - 1];
        const textLayerHost = textLayerRefs.current[pageNumber - 1];
        const renderedScale = renderedScaleRef.current.get(pageNumber);
        const textLayerScale = textLayerScaleRef.current.get(pageNumber);
        const outputScale = window.devicePixelRatio || 1;
        const targetWidth = Math.floor((metric?.width ?? 0) * outputScale);
        const targetHeight = Math.floor((metric?.height ?? 0) * outputScale);

        if (!metric || !canvas || !textLayerHost) {
          return false;
        }

        return (
          renderedScale == null ||
          textLayerScale == null ||
          Math.abs(renderedScale - renderScale) > 0.001 ||
          Math.abs(textLayerScale - renderScale) > 0.001 ||
          textLayerHost.childElementCount === 0 ||
          canvas.width !== targetWidth ||
          canvas.height !== targetHeight
        );
      });

      if (!pagesNeedingRender.length) {
        setRenderingPages(false);
        return;
      }

      setRenderingPages(true);

      try {
        for (const pageIndex of pagesNeedingRender) {
          if (cancelled) {
            break;
          }

          const canvas = canvasRefs.current[pageIndex - 1];
          const textLayerHost = textLayerRefs.current[pageIndex - 1];
          const pageMetric = renderedPageMetrics[pageIndex - 1];

          if (!canvas || !textLayerHost || !pageMetric) {
            continue;
          }

          const page = await pdf.getPage(pageIndex);
          const viewport = page.getViewport({ scale: renderScale });
          const outputScale = window.devicePixelRatio || 1;
          const context = canvas.getContext("2d");

          if (!context || cancelled) {
            continue;
          }

          canvas.width = Math.floor(pageMetric.width * outputScale);
          canvas.height = Math.floor(pageMetric.height * outputScale);

          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, canvas.width, canvas.height);

          const existingTextLayer = textLayerInstancesRef.current.get(pageIndex);
          existingTextLayer?.cancel();
          textLayerInstancesRef.current.delete(pageIndex);
          textLayerHost.replaceChildren();
          textLayerHost.style.setProperty("--scale-factor", `${viewport.scale}`);

          const renderTask = page.render({
            canvasContext: context,
            viewport,
            transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
          });
          activeTasks.push(renderTask);

          await renderTask.promise;
          if (cancelled) {
            break;
          }

          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent({
              includeMarkedContent: true,
              disableNormalization: true
            }),
            container: textLayerHost,
            viewport
          });
          textLayerInstancesRef.current.set(pageIndex, textLayer);
          await textLayer.render();
          const endOfContent = document.createElement("div");
          endOfContent.className = "endOfContent";
          textLayerHost.append(endOfContent);
          renderedScaleRef.current.set(pageIndex, renderScale);
          textLayerScaleRef.current.set(pageIndex, renderScale);
        }
      } catch (nextError) {
        if (!cancelled && !isExpectedPdfAbort(nextError)) {
          setError(nextError instanceof Error ? nextError.message : "Failed to render PDF preview.");
        }
      } finally {
        if (!cancelled) {
          setRenderingPages(false);
        }
      }
    };

    void renderVisiblePages();

    return () => {
      cancelled = true;
      for (const task of activeTasks) {
        task.cancel();
      }
      activeTasks.length = 0;
    };
  }, [currentPage, pageCount, pageMetrics.length, renderScale, renderWindow, renderedPageMetrics]);

  useEffect(() => {
    const root = containerRef.current;

    if (!root || !pageCount) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        let bestPage = currentPageRef.current;
        let bestRatio = 0;

        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber ?? "0");

          if (pageNumber > 0 && !entry.isIntersecting) {
            pageVisibilityRef.current.set(pageNumber, 0);
            continue;
          }

          if (!entry.isIntersecting) {
            continue;
          }

          const ratio = entry.intersectionRatio;

          if (pageNumber > 0) {
            pageVisibilityRef.current.set(pageNumber, ratio);
          }
        }

        for (const [pageNumber, ratio] of pageVisibilityRef.current.entries()) {
          if (ratio >= bestRatio) {
            bestRatio = ratio;
            bestPage = pageNumber;
          }
        }

        if (bestPage !== currentPageRef.current) {
          currentPageRef.current = bestPage;
          setCurrentPage(bestPage);
        }
      },
      {
        root,
        threshold: [0.2, 0.35, 0.5, 0.65, 0.8]
      }
    );

    pageVisibilityRef.current.clear();

    for (const frame of pageFrameRefs.current) {
      if (frame) {
        observer.observe(frame);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [pageCount, props.data]);

  useEffect(() => {
    const node = containerRef.current;

    if (!node) {
      return;
    }

    const handleScroll = () => {
      if (scrollAnimationFrameRef.current == null) {
        scrollAnimationFrameRef.current = window.requestAnimationFrame(() => {
          setScrollTop(node.scrollTop);
          scrollAnimationFrameRef.current = null;
        });
      }

      queueViewerStateWrite(props.storageKey, {
        currentPage: currentPageRef.current,
        scrollTop: node.scrollTop,
        scrollLeft: node.scrollLeft,
        zoomMode,
        zoomScale
      });
    };

    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      if (scrollAnimationFrameRef.current != null) {
        window.cancelAnimationFrame(scrollAnimationFrameRef.current);
        scrollAnimationFrameRef.current = null;
      }
      node.removeEventListener("scroll", handleScroll);
    };
  }, [props.storageKey, zoomMode, zoomScale]);

  useEffect(() => {
    const node = containerRef.current;

    if (!node) {
      return;
    }

    queueViewerStateWrite(props.storageKey, {
      currentPage,
      scrollTop: node.scrollTop,
      scrollLeft: node.scrollLeft,
      zoomMode,
      zoomScale
    });
  }, [currentPage, props.storageKey, zoomMode, zoomScale]);

  useEffect(() => {
    const node = containerRef.current;

    if (!node) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();
      const deltaMultiplier =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? node.getBoundingClientRect().height
            : 1;
      const normalizedDelta = event.deltaY * deltaMultiplier;
      const factor = Math.exp(-normalizedDelta * 0.0015);
      const anchorPoint = resolveWheelAnchorPoint(event);

      zoomAnchorRef.current = resolveZoomAnchor(anchorPoint.clientX, anchorPoint.clientY);

      const nextScale = clampZoom(currentVisualScaleRef.current * factor);

      if (zoomAnimationFrameRef.current != null) {
        window.cancelAnimationFrame(zoomAnimationFrameRef.current);
      }

      zoomAnimationFrameRef.current = window.requestAnimationFrame(() => {
        setZoomMode("manual");
        setZoomScale(nextScale);
        zoomAnimationFrameRef.current = null;
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointerPositionRef.current = {
        clientX: event.clientX,
        clientY: event.clientY
      };
    };

    node.addEventListener("wheel", handleWheel, { passive: false });
    node.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      if (zoomAnimationFrameRef.current != null) {
        window.cancelAnimationFrame(zoomAnimationFrameRef.current);
        zoomAnimationFrameRef.current = null;
      }
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("pointermove", handlePointerMove);
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    const savedState = readViewerState(props.storageKey);

    if (!node || !pageCount || restoredScrollRef.current || savedState == null) {
      return;
    }

    restoredScrollRef.current = true;
    node.scrollTop = savedState.scrollTop;
    node.scrollLeft = savedState.scrollLeft;
    setScrollTop(savedState.scrollTop);

    if (savedState.currentPage && savedState.currentPage !== currentPageRef.current) {
      currentPageRef.current = savedState.currentPage;
      setCurrentPage(savedState.currentPage);
    }
  }, [pageCount, props.storageKey, renderingPages]);

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const node = containerRef.current;

    if (!anchor || !node || renderingPages) {
      return;
    }

    const frame = pageFrameRefs.current[anchor.pageNumber - 1];

    if (!frame) {
      zoomAnchorRef.current = null;
      return;
    }

    const nodeRect = node.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const frameTop = node.scrollTop + frameRect.top - nodeRect.top;
    const frameLeft = node.scrollLeft + frameRect.left - nodeRect.left;

    node.scrollTo({
      top: Math.max(0, frameTop + frame.clientHeight * anchor.yRatio - anchor.anchorOffsetY),
      left: Math.max(0, frameLeft + frame.clientWidth * anchor.xRatio - anchor.anchorOffsetX),
      behavior: "auto"
    });
    setScrollTop(node.scrollTop);
    zoomAnchorRef.current = null;
  }, [renderingPages, renderedPageMetrics]);

  useEffect(() => {
    if (
      !props.jumpNonce ||
      appliedJumpNonceRef.current === props.jumpNonce ||
      !props.jumpTarget ||
      !pageCount ||
      documentLoading ||
      renderingPages
    ) {
      return;
    }

    const frame = pageFrameRefs.current[props.jumpTarget.pageNumber - 1];
    if (!frame || frame.clientHeight <= 0) {
      return;
    }

    appliedJumpNonceRef.current = props.jumpNonce;
    scrollToPage(props.jumpTarget.pageNumber, "smooth", props.jumpTarget.yRatio);
  }, [documentLoading, pageCount, props.jumpNonce, props.jumpTarget, renderingPages, renderScale]);

  function scrollToPage(pageNumber: number, behavior: ScrollBehavior, yRatio?: number | null) {
    const frame = pageFrameRefs.current[pageNumber - 1];
    const node = containerRef.current;

    if (!frame || !node) {
      return;
    }

    const nodeRect = node.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const frameTop = node.scrollTop + frameRect.top - nodeRect.top;

    if (yRatio != null) {
      node.scrollTo({
        top: Math.max(0, frameTop + frame.clientHeight * clampRatio(yRatio) - 56),
        behavior
      });
    } else {
      node.scrollTo({
        top: Math.max(0, frameTop - 20),
        behavior
      });
    }

    currentPageRef.current = pageNumber;
    setCurrentPage(pageNumber);
  }

  function resolveZoomAnchor(clientX: number, clientY: number): PdfZoomAnchor | null {
    const node = containerRef.current;

    if (!node) {
      return null;
    }

    for (let index = 0; index < pageFrameRefs.current.length; index += 1) {
      const frame = pageFrameRefs.current[index];

      if (!frame) {
        continue;
      }

      const rect = frame.getBoundingClientRect();

      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return createZoomAnchor(frame, index + 1, clientX, clientY);
      }
    }

    const fallbackFrame = pageFrameRefs.current[currentPageRef.current - 1];

    if (fallbackFrame) {
      return createCenteredZoomAnchor(fallbackFrame, currentPageRef.current);
    }

    const nodeRect = node.getBoundingClientRect();
    return {
      pageNumber: currentPageRef.current,
      xRatio: 0.5,
      yRatio: 0.5,
      anchorOffsetX: nodeRect.width / 2,
      anchorOffsetY: nodeRect.height / 2
    };
  }

  function resolveWheelAnchorPoint(event: WheelEvent) {
    const node = containerRef.current;

    if (!node) {
      return { clientX: event.clientX, clientY: event.clientY };
    }

    const rect = node.getBoundingClientRect();
    const pointer = pointerPositionRef.current;
    const pointerInside =
      pointer &&
      pointer.clientX >= rect.left &&
      pointer.clientX <= rect.right &&
      pointer.clientY >= rect.top &&
      pointer.clientY <= rect.bottom;

    if (pointerInside) {
      return pointer;
    }

    const eventInside =
      Number.isFinite(event.clientX) &&
      Number.isFinite(event.clientY) &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;

    if (eventInside) {
      return { clientX: event.clientX, clientY: event.clientY };
    }

    return {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
  }

  function createZoomAnchor(
    frame: HTMLDivElement,
    pageNumber: number,
    clientX: number,
    clientY: number
  ): PdfZoomAnchor {
    const nodeRect = containerRef.current?.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();

    return {
      pageNumber,
      xRatio: clampRatio((clientX - frameRect.left) / Math.max(frameRect.width, 1)),
      yRatio: clampRatio((clientY - frameRect.top) / Math.max(frameRect.height, 1)),
      anchorOffsetX: clientX - (nodeRect?.left ?? 0),
      anchorOffsetY: clientY - (nodeRect?.top ?? 0)
    };
  }

  function createCenteredZoomAnchor(frame: HTMLDivElement, pageNumber: number): PdfZoomAnchor {
    const nodeRect = containerRef.current?.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const centerX = frameRect.left + frameRect.width / 2;
    const centerY = frameRect.top + frameRect.height / 2;

    return {
      pageNumber,
      xRatio: 0.5,
      yRatio: 0.5,
      anchorOffsetX: centerX - (nodeRect?.left ?? 0),
      anchorOffsetY: centerY - (nodeRect?.top ?? 0)
    };
  }

  return (
    <div className="pdf-viewer-shell" data-preview-theme={props.themeMode}>
      <div className="pdf-canvas-shell" ref={containerRef}>
        {documentLoading && !pageCount ? <div className="pdf-empty-state">Loading PDF preview…</div> : null}
        {error ? <div className="pdf-empty-state">{error}</div> : null}
        {!error && pageCount > 0 ? (
          <div className="pdf-pages-viewport">
            <div className="pdf-pages-track" style={pageTrackStyle}>
              {Array.from({ length: pageCount }, (_, index) => {
                const pageNumber = index + 1;
                const metric = renderedPageMetrics[index];

                return (
                  <div
                    className="pdf-page-frame"
                    data-page-number={pageNumber}
                    key={`${props.storageKey}-${pageNumber}`}
                    onDoubleClick={(event) => {
                      if (!props.onNavigateSource) {
                        return;
                      }

                      const frame = pageFrameRefs.current[index];
                      if (!frame) {
                        return;
                      }

                      const rect = frame.getBoundingClientRect();
                      const yRatio = clampRatio((event.clientY - rect.top) / Math.max(rect.height, 1));
                      props.onNavigateSource({
                        pageNumber,
                        yRatio
                      });
                    }}
                    onMouseUp={() => {
                      if (!props.onNavigateSource) {
                        return;
                      }

                      const selection = window.getSelection();
                      const textLayer = textLayerRefs.current[index];
                      const frame = pageFrameRefs.current[index];

                      if (
                        !selection ||
                        selection.isCollapsed ||
                        selection.rangeCount === 0 ||
                        !textLayer ||
                        !frame ||
                        selection.toString().trim().length === 0
                      ) {
                        return;
                      }

                      const range = selection.getRangeAt(0);

                      if (!range.intersectsNode(textLayer)) {
                        return;
                      }

                      const rect = range.getBoundingClientRect();
                      const frameRect = frame.getBoundingClientRect();

                      if (rect.height <= 0 || frameRect.height <= 0) {
                        return;
                      }

                      props.onNavigateSource({
                        pageNumber,
                        yRatio: clampRatio((rect.top + rect.height / 2 - frameRect.top) / frameRect.height)
                      });
                    }}
                    ref={(node) => {
                      pageFrameRefs.current[index] = node;
                    }}
                    style={metric ? { width: `${metric.width}px`, height: `${metric.height}px` } : undefined}
                  >
                    <canvas
                      ref={(node) => {
                        canvasRefs.current[index] = node;
                      }}
                    />
                    <div
                      className="pdf-text-layer-host textLayer"
                      ref={(node) => {
                        textLayerRefs.current[index] = node;
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {renderingPages && pageCount > 0 ? <div className="pdf-rendering-hint">Rendering preview…</div> : null}
      </div>
    </div>
  );
}

function isExpectedPdfAbort(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "RenderingCancelledException" ||
      error.name === "AbortException" ||
      error.message.toLowerCase().includes("rendering cancelled"))
  );
}
