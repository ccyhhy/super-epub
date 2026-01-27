import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App, Notice, TFile } from "obsidian";
import { ReactReader, ReactReaderStyle, type IReactReaderStyle } from "react-reader";
import type { Contents, Rendition } from "epubjs";
import type { BacklinkHighlight } from "../services/BacklinkManager";
import { base64UrlEncode, parseColorComponents, sanitizeLinkText } from "../shared/utils";
import { useObsidianTheme } from "./hooks/useObsidianTheme";
import { useObsidianTypography } from "./hooks/useObsidianTypography";

type ToolbarState = {
  visible: boolean;
  x: number;
  y: number;
  cfiRange: string;
  text: string;
};

const DEFAULT_HIGHLIGHT_COLOR = "#ffd700";

function getRangeStartCfi(cfi: string): string | null {
  const m = cfi.match(/^epubcfi\((.+?),/);
  return m?.[1] ? `epubcfi(${m[1]})` : null;
}

type Props = {
  app: App;
  file: TFile;
  title: string;
  contents: ArrayBuffer;
  scrolled: boolean;
  highlightColor: string;
  highlightOpacity: number;
  fontSizePercent: number;
  followObsidianTheme: boolean;
  followObsidianFont: boolean;
  initialLocation: string | number;
  jumpCfiRange: string | null;
  highlights: BacklinkHighlight[];
  onLocationChange: (loc: string | number) => void;
  onOpenNote: (note: TFile) => void;
  onUserActivity: () => void;
  onRegisterActions?: (actions: { toggleToc: () => void }) => void;
};

export const EpubReader: React.FC<Props> = ({
  app,
  file,
  title,
  contents,
  scrolled,
  highlightColor,
  highlightOpacity,
  fontSizePercent,
  followObsidianTheme,
  followObsidianFont,
  initialLocation,
  jumpCfiRange,
  highlights,
  onLocationChange,
  onOpenNote,
  onUserActivity,
  onRegisterActions,
}) => {
  const renditionRef = useRef<Rendition | null>(null);
  const pendingJumpRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastSelectionAtRef = useRef(0);
  const highlightsRef = useRef<BacklinkHighlight[]>([]);
  const selectionColorRef = useRef<string>("");

  const [rendition, setRendition] = useState<Rendition | null>(null);
  const [location, setLocation] = useState<string | number>(initialLocation);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const isDarkMode = useObsidianTheme(followObsidianTheme);
  const obsidianTypography = useObsidianTypography(followObsidianFont);
  const isMobile = useMemo(() => {
    const appMobile = Boolean((app as any)?.isMobile);
    if (appMobile) return true;
    if (typeof document !== "undefined") {
      const body = document.body;
      if (body?.classList?.contains("is-mobile")) return true;
      if (body?.classList?.contains("is-phone")) return true;
    }
    if (typeof navigator !== "undefined") {
      if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
    }
    if (typeof window !== "undefined") {
      if (window.matchMedia?.("(pointer: coarse)").matches && window.innerWidth <= 900) return true;
    }
    return false;
  }, [app]);

  // Track backlink highlights we added so we can remove them before re-adding.
  const addedBacklinkCfisRef = useRef<string[]>([]);

  useEffect(() => {
    if (!portalTarget && containerRef.current?.ownerDocument?.body) {
      setPortalTarget(containerRef.current.ownerDocument.body);
    }
  }, [portalTarget]);

  const clearSelection = useCallback(() => {
    const r = renditionRef.current;
    if (!r) return;

    // Type-safe: getContents() typing differs across epubjs/react-reader versions
    const gc: any = (r as any).getContents?.();

    const list: any[] = Array.isArray(gc) ? gc : gc ? [gc] : [];

    for (const c of list) {
      try {
        c?.window?.getSelection?.()?.removeAllRanges?.();
      } catch {
        // ignore
      }
    }
  }, []);

  const writeClipboard = useCallback(
    async (text: string) => {
      // @ts-ignore
      const cm = app.clipboardManager;
      if (cm?.writeText) {
        await cm.writeText(text);
        return;
      }
      await navigator.clipboard.writeText(text);
    },
    [app]
  );

  const updateTheme = useCallback((rendition: Rendition) => {
    const themes = rendition.themes;
    themes.override("color", isDarkMode ? "#fff" : "#000");
    themes.override("background", isDarkMode ? "#000" : "#fff");
  }, [isDarkMode]);

  const applyFontSize = useCallback((rendition: Rendition, size: number) => {
    rendition.themes.fontSize(`${size}%`);
  }, []);

  const applyTypography = useCallback(
    (rendition: Rendition) => {
      const themes: any = rendition.themes;
      if (followObsidianFont) {
        if (obsidianTypography.fontFamily) {
          themes.override("font-family", obsidianTypography.fontFamily);
        }
        if (obsidianTypography.fontSize) {
          themes.override("font-size", obsidianTypography.fontSize);
        }
        return;
      }

      themes.remove?.("font-family");
      themes.remove?.("font-size");
      applyFontSize(rendition, fontSizePercent);
    },
    [followObsidianFont, obsidianTypography, fontSizePercent, applyFontSize]
  );

  useEffect(() => {
    if (!rendition) return;
    updateTheme(rendition);
  }, [rendition, updateTheme]);

  const tryDisplayCfi = useCallback(async (rendition: Rendition, cfi: string): Promise<boolean> => {
    const ready = (rendition as any)?.book?.ready;
    if (ready && typeof ready.then === "function") {
      try {
        await ready;
      } catch {
        // ignore
      }
    }

    try {
      await rendition.display(cfi);
      return true;
    } catch {
      return false;
    }
  }, []);

  const displayJumpCfi = useCallback(
    async (cfi: string): Promise<boolean> => {
      const r = renditionRef.current;
      if (!r) return false;

      const primary = getRangeStartCfi(cfi) ?? cfi;
      if (await tryDisplayCfi(r, primary)) return true;

      if (primary !== cfi) {
        return await tryDisplayCfi(r, cfi);
      }

      return false;
    },
    [tryDisplayCfi]
  );

  const locationChanged = useCallback(
    (epubcfi: string | number) => {
      setLocation(epubcfi);
      onLocationChange(epubcfi);
      setToolbar(null);
      onUserActivity?.();
    },
    [onLocationChange, onUserActivity]
  );

  // 计算高亮颜色样式
  const highlightStyles = useMemo(() => {
    const { r, g, b, alpha } = parseColorComponents(highlightColor, DEFAULT_HIGHLIGHT_COLOR);
    // 将透明度百分比转换为0-1范围，并保留颜色自身的alpha
    const baseOpacity = (highlightOpacity / 100) * alpha;
    const fillColor = `rgb(${r}, ${g}, ${b})`;
    const fillOpacity = baseOpacity * 0.35;
    const selectionOpacity = Math.min(0.5, baseOpacity * 0.5);
    const selectionColor = `rgba(${r}, ${g}, ${b}, ${selectionOpacity})`;
    const cornerRadius = 2;
    return {
      fillColor,
      fillOpacity,
      selectionColor,
      cornerRadius,
    };
  }, [highlightColor, highlightOpacity]);

  const applySelectionStyle = useCallback((c: Contents, color: string) => {
    try {
      const existing = c.document.getElementById("epubjs-selection-style") as HTMLStyleElement | null;
      const style = existing ?? c.document.createElement("style");
      style.id = "epubjs-selection-style";
      style.innerHTML = `::selection { background: ${color}; }`;
      if (!existing) c.document.head.appendChild(style);
    } catch {
      // ignore
    }
  }, []);

  // Receive jump request: if rendition not ready yet, hold it.
  useEffect(() => {
    if (!jumpCfiRange) return;
    pendingJumpRef.current = jumpCfiRange;
    displayJumpCfi(jumpCfiRange).then((ok) => {
      if (ok) pendingJumpRef.current = null;
    });
  }, [jumpCfiRange, displayJumpCfi]);

  // Cleanup-first backlinks render
  const applyBacklinkHighlights = useCallback(
    (r: Rendition, next: BacklinkHighlight[]) => {
      // remove old
      for (const cfi of addedBacklinkCfisRef.current) {
        try {
          r.annotations.remove(cfi, "highlight");
        } catch {
          // ignore
        }
      }
      addedBacklinkCfisRef.current = [];

      // add new (cap for perf)
      const capped = (next ?? []).slice(0, 80);
      for (const hl of capped) {
        try {
          r.annotations.add(
            "highlight",
            hl.cfiRange,
            {},
            () => {
              new Notice(`\u6253\u5f00\u53cd\u94fe\uff1a${hl.display}`);
              onOpenNote(hl.sourceFile);
            },
            "epubjs-backlink-hl"
          );
          addedBacklinkCfisRef.current.push(hl.cfiRange);
        } catch {
          // ignore invalid ranges
        }
      }
    },
    [onOpenNote]
  );

  useEffect(() => {
    highlightsRef.current = highlights;
  }, [highlights]);

  useEffect(() => {
    selectionColorRef.current = highlightStyles.selectionColor;
    const r = renditionRef.current;
    const contents: any = (r as any)?.getContents?.();
    const list = Array.isArray(contents) ? contents : contents ? [contents] : [];
    for (const c of list) {
      applySelectionStyle(c, selectionColorRef.current);
    }
  }, [highlightStyles, applySelectionStyle]);

  useEffect(() => {
    if (!rendition) return;
    applyTypography(rendition);

    let cancelled = false;
    const run = async () => {
      const ready = (rendition as any)?.book?.ready;
      if (ready && typeof ready.then === "function") {
        try {
          await ready;
        } catch {
          // ignore
        }
      }
      if (cancelled) return;
      applyBacklinkHighlights(rendition, highlights);
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [rendition, highlights, applyTypography, applyBacklinkHighlights]);

  const onSelected = useCallback((cfiRange: string, contents: Contents) => {
    const sel = contents.window?.getSelection?.();
    if (!sel || sel.rangeCount === 0) return;

    const text = sel.toString();
    if (!text || !text.trim()) return;

    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[0] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    // Reliable iframe offset: frameElement of this contents
    const frameEl = contents.document?.defaultView?.frameElement as HTMLElement | null;
    if (!frameEl) return;

    const iframeRect = frameEl.getBoundingClientRect();

    const absX = iframeRect.left + rect.left + rect.width / 2;
    let absY = iframeRect.top + rect.top - 44; // above selection
    if (absY < 24) absY = iframeRect.top + rect.bottom + 10; // below if near top

    // Convert viewport coords -> container coords (avoids issues with transforms/fixed positioning in Obsidian)
    const x = absX;
    const y = absY;

    lastSelectionAtRef.current = Date.now();
    onUserActivity?.();
    setToolbar({
      visible: true,
      x,
      y,
      cfiRange,
      text,
    });
  }, [onUserActivity]);

  const goNext = useCallback(() => {
    const r: any = renditionRef.current;
    r?.next?.();
    onUserActivity?.();
  }, [onUserActivity]);

  const goPrev = useCallback(() => {
    const r: any = renditionRef.current;
    r?.prev?.();
    onUserActivity?.();
  }, [onUserActivity]);

  useEffect(() => {
    if (!isMobile) return;
    if (scrolled) return;
    const doc = containerRef.current?.ownerDocument ?? document;

    const isEditableTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    };

    const handler = (evt: KeyboardEvent) => {
      if (isEditableTarget(evt.target)) return;
      const key = evt.key;
      const code = (evt as any).code;
      const keyCode = (evt as any).keyCode;
      const isVolUp =
        key === "AudioVolumeUp" ||
        key === "VolumeUp" ||
        code === "AudioVolumeUp" ||
        keyCode === 175;
      const isVolDown =
        key === "AudioVolumeDown" ||
        key === "VolumeDown" ||
        code === "AudioVolumeDown" ||
        keyCode === 174;
      if (!isVolUp && !isVolDown) return;
      evt.preventDefault();
      evt.stopPropagation();
      onUserActivity?.();
      if (isVolUp) {
        goPrev();
      } else {
        goNext();
      }
    };

    doc.addEventListener("keydown", handler, true);
    return () => {
      doc.removeEventListener("keydown", handler, true);
    };
  }, [isMobile, scrolled, goNext, goPrev, onUserActivity]);


  useEffect(() => {
    if (!rendition) return;

    const handleClick = () => {
      const now = Date.now();
      if (now - lastSelectionAtRef.current < 200) return;
      setToolbar(null);
    };

    const handleRelocated = (location: any) => {
      setToolbar(null);
      onUserActivity?.();
    };
    const handleRendered = () => {
      applyBacklinkHighlights(rendition, highlightsRef.current);
    };

    const hook = (c: Contents) => {
      try {
        const body = c.window.document.body;
        body.oncontextmenu = () => false;
        applySelectionStyle(c, selectionColorRef.current);
      } catch {
        // ignore
      }
    };

    rendition.on("selected", onSelected);
    rendition.on("click", handleClick);
    rendition.on("relocated", handleRelocated);
    rendition.on("rendered", handleRendered);
    const contentHook = (rendition.hooks as any)?.content;
    contentHook?.register?.(hook);
    const initialContents: any = (rendition as any).getContents?.();
    const initialList = Array.isArray(initialContents) ? initialContents : initialContents ? [initialContents] : [];
    if (initialList.length) {
      for (const c of initialList) hook(c);
      handleRendered();
    }

    return () => {
      rendition.off("selected", onSelected);
      rendition.off("click", handleClick);
      rendition.off("relocated", handleRelocated);
      rendition.off("rendered", handleRendered);
      contentHook?.unregister?.(hook);
    };
  }, [
    rendition,
    onSelected,
    applyBacklinkHighlights,
    applySelectionStyle,
    onUserActivity,
  ]);

  useEffect(() => {
    const doc = containerRef.current?.ownerDocument;
    if (!doc) return;

    const styleId = "epubjs-backlink-overlay-style";
    const existing = doc.getElementById(styleId) as HTMLStyleElement | null;
    const style = existing ?? doc.createElement("style");
    style.id = styleId;
    style.innerHTML = `
      .epubjs-backlink-hl rect {
        fill: ${highlightStyles.fillColor} !important;
        fill-opacity: ${highlightStyles.fillOpacity} !important;
        stroke: none !important;
        stroke-opacity: 0 !important;
        stroke-width: 0 !important;
        rx: ${highlightStyles.cornerRadius}px;
        ry: ${highlightStyles.cornerRadius}px;
        cursor: pointer;
      }
    `;
    if (!existing) doc.head.appendChild(style);
  }, [highlightStyles]);

  const handleCopyLink = useCallback(async () => {
    if (!toolbar) return;

    let label = sanitizeLinkText(toolbar.text);
    if (!label) label = "\u5f15\u7528";
    if (label.length > 60) label = label.slice(0, 60) + "...";

    const cfi64 = base64UrlEncode(toolbar.cfiRange);
    // Use full path so links resolve uniquely
    const link = `[[${file.path}#cfi64=${cfi64}|${label}]]`;

    try {
      await writeClipboard(link);
      new Notice("EPUB \u94fe\u63a5\u5df2\u590d\u5236");
    } catch {
      new Notice("\u590d\u5236\u5931\u8d25");
    } finally {
      setToolbar(null);
      clearSelection();
    }
  }, [toolbar, file.path, writeClipboard, clearSelection]);

  const readerStyles = useMemo<IReactReaderStyle>(() => {
    const base = isDarkMode ? darkReaderTheme : lightReaderTheme;

    // Always hide built-in arrows so only our tap zones control paging.
    const baseWithHiddenArrows: IReactReaderStyle = {
      ...base,
      arrow: {
        ...base.arrow,
        display: "none",
        visibility: "hidden",
        pointerEvents: "none",
      },
      prev: {
        ...base.prev,
        display: "none",
      },
      next: {
        ...base.next,
        display: "none",
      },
    };

    if (!isMobile) return baseWithHiddenArrows;

    const next: IReactReaderStyle = {
      ...baseWithHiddenArrows,
      reader: {
        ...baseWithHiddenArrows.reader,
        top: "8px",
        left: "8px",
        right: "8px",
        bottom: "8px",
      },
      readerArea: {
        ...baseWithHiddenArrows.readerArea,
        padding: "0 2px",
      },
      tocButton: {
        ...baseWithHiddenArrows.tocButton,
        display: "none",
        top: "8px",
        right: "8px",
        left: "auto",
        width: "36px",
        height: "36px",
        borderRadius: "999px",
        background: "var(--background-primary)",
        boxShadow: "0 6px 16px rgba(0, 0, 0, 0.2)",
        opacity: 0.85,
      },
      tocButtonBar: {
        ...baseWithHiddenArrows.tocButtonBar,
        background: "var(--text-normal)",
      },
      tocButtonBarTop: {
        ...baseWithHiddenArrows.tocButtonBarTop,
      },
      tocButtonBarBottom: {
        ...baseWithHiddenArrows.tocButtonBarBottom,
      },
    };
    return next;
  }, [isDarkMode, isMobile]);

  useEffect(() => {
    if (!onRegisterActions) return;
    const toggleToc = () => {
      const container = containerRef.current;
      if (!container) return;
      const buttons = Array.from(container.querySelectorAll("button"));
      const tocBtn = buttons.find((btn) => {
        if (btn.textContent && btn.textContent.trim()) return false;
        const spans = btn.querySelectorAll("span");
        return spans.length === 2;
      });
      tocBtn?.click();
    };
    onRegisterActions({ toggleToc });
  }, [onRegisterActions]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const hideArrows = () => {
      const buttons = Array.from(root.querySelectorAll("button"));
      for (const btn of buttons) {
        const text = (btn.textContent ?? "").trim();
        if (text === "\u2039" || text === "\u203A") {
          btn.style.display = "none";
          btn.style.pointerEvents = "none";
        }
      }
    };
    hideArrows();
    const observer = new MutationObserver(() => hideArrows());
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const toolbarNode = toolbar && toolbar.visible ? (
    <div
      className="epub-toolbar"
      style={{ left: toolbar.x, top: toolbar.y, position: "fixed" }}
      onMouseDown={(e) => e.preventDefault()} // keep selection until click
    >
      <button
        className="mod-cta epub-toolbar__button"
        onClick={handleCopyLink}
        aria-label="\u590d\u5236\u94fe\u63a5"
        title="\u590d\u5236\u94fe\u63a5"
      >
        复制链接
      </button>
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      style={{
        height: "100%",
        width: "100%",
        position: "relative",
        overflow: scrolled ? "auto" : "hidden",
      }}
    >
      {isMobile && !scrolled ? (
        <div className="epub-tap-zones">
          <button
            type="button"
            className="epub-tap-zone epub-tap-zone--prev"
            aria-label="上一页"
            onClick={goPrev}
          />
          <button
            type="button"
            className="epub-tap-zone epub-tap-zone--next"
            aria-label="下一页"
            onClick={goNext}
          />
        </div>
      ) : null}
      {/* Floating toolbar */}
      {portalTarget && toolbarNode ? createPortal(toolbarNode, portalTarget) : toolbarNode}

      <ReactReader
        title={title}
        showToc={true}
        location={location}
        locationChanged={locationChanged}
        swipeable={false}
        url={contents}
        getRendition={(rendition: Rendition) => {
          renditionRef.current = rendition;
          addedBacklinkCfisRef.current = [];
          setRendition(rendition);

          updateTheme(rendition);
          applyTypography(rendition);

          // apply pending jump if any
          if (pendingJumpRef.current) {
            const cfi = pendingJumpRef.current;
            displayJumpCfi(cfi).then((ok) => {
              if (ok) pendingJumpRef.current = null;
            });
          }
        }}
        epubOptions={
          scrolled
            ? {
                allowPopups: true,
                flow: "scrolled",
                manager: "continuous",
              }
            : undefined
        }
        readerStyles={readerStyles}
      />
    </div>
  );
};

const lightReaderTheme: IReactReaderStyle = {
  ...ReactReaderStyle,
  arrow: {
    ...ReactReaderStyle.arrow,
    backgroundColor: "transparent",
    border: "none",
    boxShadow: "none",
  },
  arrowHover: {
    ...ReactReaderStyle.arrowHover,
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  readerArea: {
    ...ReactReaderStyle.readerArea,
    padding: "0 6px",
    transition: undefined,
  },
  titleArea: {
    ...ReactReaderStyle.titleArea,
    display: "none",
    height: 0,
    margin: 0,
    padding: 0,
  },
};

const darkReaderTheme: IReactReaderStyle = {
  ...ReactReaderStyle,
  arrow: {
    ...ReactReaderStyle.arrow,
    color: "white",
    backgroundColor: "transparent",
    border: "none",
    boxShadow: "none",
  },
  arrowHover: {
    ...ReactReaderStyle.arrowHover,
    color: "#ccc",
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  readerArea: {
    ...ReactReaderStyle.readerArea,
    padding: "0 6px",
    backgroundColor: "#000",
    transition: undefined,
  },
  titleArea: {
    ...ReactReaderStyle.titleArea,
    display: "none",
    height: 0,
    margin: 0,
    padding: 0,
  },
  tocArea: {
    ...ReactReaderStyle.tocArea,
    background: "#111",
  },
  tocButtonExpanded: {
    ...ReactReaderStyle.tocButtonExpanded,
    background: "#222",
  },
  tocButtonBar: {
    ...ReactReaderStyle.tocButtonBar,
    background: "#fff",
  },
  tocButton: {
    ...ReactReaderStyle.tocButton,
    color: "white",
  },
};
