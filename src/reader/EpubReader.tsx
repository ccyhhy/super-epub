import * as React from "react";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { App, Notice, TFile } from "obsidian";
import { ReactReader, ReactReaderStyle, type IReactReaderStyle } from "react-reader";
import type { Contents, Rendition } from "epubjs";
import type { BacklinkHighlight } from "../services/BacklinkManager";
import { base64UrlEncode, sanitizeLinkText } from "../shared/utils";
import { useObsidianTheme } from "./hooks/useObsidianTheme";
import { useObsidianTypography } from "./hooks/useObsidianTypography";
import { useHighlightStyles } from "./hooks/useHighlightStyles";
import { useReaderTheme } from "./hooks/useReaderTheme";
import { useSelectionToolbar } from "./hooks/useSelectionToolbar";

function getRangeStartCfi(cfi: string): string | null {
  const m = cfi.match(/^epubcfi\((.+?),/);
  return m?.[1] ? `epubcfi(${m[1]})` : null;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
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
  lineHeight: number;
  paragraphSpacingEm: number;
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
  lineHeight,
  paragraphSpacingEm,
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
  const highlightsRef = useRef<BacklinkHighlight[]>([]);
  const selectionColorRef = useRef<string>("");
  const addedBacklinkCfisRef = useRef<string[]>([]);

  const [rendition, setRendition] = useState<Rendition | null>(null);
  const [location, setLocation] = useState<string | number>(initialLocation);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // Custom hooks (#7)
  const isDarkMode = useObsidianTheme(followObsidianTheme);
  const obsidianTypography = useObsidianTypography(followObsidianFont);
  const normalizedLineHeight = clamp(lineHeight, 1.2, 2.4, 1.75);
  const normalizedParagraphSpacingEm = clamp(paragraphSpacingEm, 0, 1.5, 0.4);
  const highlightStyles = useHighlightStyles(highlightColor, highlightOpacity);
  const { updateTheme, applyTypography } = useReaderTheme(
    isDarkMode,
    followObsidianTheme,
    followObsidianFont,
    obsidianTypography,
    fontSizePercent,
    normalizedLineHeight
  );
  const {
    toolbar,
    toolbarRef,
    setToolbar,
    dismissToolbar,
    onSelected,
    handleClick: handleToolbarClick,
  } = useSelectionToolbar(onUserActivity);

  useEffect(() => {
    if (!portalTarget && containerRef.current?.ownerDocument?.body) {
      setPortalTarget(containerRef.current.ownerDocument.body);
    }
  }, [portalTarget]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => dismissToolbar();
    container.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    return () => {
      container.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, [dismissToolbar]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onUserActivity) return;
    let lastTick = 0;
    const minIntervalMs = 1000;
    const handleScroll = () => {
      const now = Date.now();
      if (now - lastTick < minIntervalMs) return;
      lastTick = now;
      onUserActivity();
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [onUserActivity]);

  const clearSelection = useCallback(() => {
    const r = renditionRef.current;
    if (!r) return;

    const gc: any = (r as any).getContents?.();
    const list: any[] = Array.isArray(gc) ? gc : gc ? [gc] : [];

    for (const c of list) {
      try {
        c?.window?.getSelection?.()?.removeAllRanges?.();
      } catch (err) {
        console.debug("[super-epub] clearSelection error:", err);
      }
    }
  }, []);

  const writeClipboard = useCallback(
    async (text: string) => {
      // @ts-ignore - Obsidian internal API
      const cm = app.clipboardManager;
      if (cm?.writeText) {
        await cm.writeText(text);
        return;
      }
      await navigator.clipboard.writeText(text);
    },
    [app]
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
      } catch (err) {
        console.debug("[super-epub] book.ready rejected:", err);
      }
    }

    try {
      await rendition.display(cfi);
      return true;
    } catch (err) {
      console.debug("[super-epub] display cfi failed:", err);
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
      dismissToolbar();
      onUserActivity?.();
    },
    [onLocationChange, onUserActivity, dismissToolbar]
  );

  // --- Style injection helpers ---

  const applySelectionStyle = useCallback((c: Contents, color: string) => {
    try {
      const existing = c.document.getElementById("epubjs-selection-style") as HTMLStyleElement | null;
      const style = existing ?? c.document.createElement("style");
      style.id = "epubjs-selection-style";
      style.innerHTML = `::selection { background: ${color}; }`;
      if (!existing) c.document.head.appendChild(style);
    } catch (err) {
      console.debug("[super-epub] applySelectionStyle error:", err);
    }
  }, []);

  const applyBacklinkStyle = useCallback(
    (c: Contents) => {
      try {
        const doc = c.document;
        const existing = doc.getElementById("epubjs-backlink-overlay-style") as HTMLStyleElement | null;
        const style = existing ?? doc.createElement("style");
        style.id = "epubjs-backlink-overlay-style";
        style.innerHTML = `
          .epubjs-backlink-hl rect {
            fill: ${highlightStyles.fillColor} !important;
            fill-opacity: ${highlightStyles.fillOpacity} !important;
            mix-blend-mode: normal !important;
            stroke: none !important;
            stroke-opacity: 0 !important;
            stroke-width: 0 !important;
            rx: ${highlightStyles.cornerRadius}px;
            ry: ${highlightStyles.cornerRadius}px;
            cursor: pointer;
          }
        `;
        if (!existing) doc.head.appendChild(style);
      } catch (err) {
        console.debug("[super-epub] applyBacklinkStyle error:", err);
      }
    },
    [highlightStyles]
  );

  const applyReadingLayoutStyle = useCallback(
    (c: Contents) => {
      try {
        const doc = c.document;
        const existing = doc.getElementById("epubjs-reading-layout-style") as HTMLStyleElement | null;
        const style = existing ?? doc.createElement("style");
        style.id = "epubjs-reading-layout-style";
        style.innerHTML = `
          html, body {
            line-height: ${normalizedLineHeight} !important;
          }
          p + p {
            margin-top: ${normalizedParagraphSpacingEm}em !important;
          }
        `;
        if (!existing) doc.head.appendChild(style);
      } catch (err) {
        console.debug("[super-epub] applyReadingLayoutStyle error:", err);
      }
    },
    [normalizedLineHeight, normalizedParagraphSpacingEm]
  );

  // Receive jump request: if rendition not ready yet, hold it.
  useEffect(() => {
    if (!jumpCfiRange) return;
    pendingJumpRef.current = jumpCfiRange;
    displayJumpCfi(jumpCfiRange).then((ok) => {
      if (ok) pendingJumpRef.current = null;
    });
  }, [jumpCfiRange, displayJumpCfi]);

  // --- Backlink highlights (#3: unified into single application point) ---

  const applyBacklinkHighlights = useCallback(
    (r: Rendition, next: BacklinkHighlight[]) => {
      // remove old
      for (const cfi of addedBacklinkCfisRef.current) {
        try {
          r.annotations.remove(cfi, "highlight");
        } catch (err) {
          console.debug("[super-epub] remove highlight error:", err);
        }
      }
      addedBacklinkCfisRef.current = [];

      // add new (cap for perf)
      const capped = (next ?? []).slice(0, 80);
      for (const hl of capped) {
        try {
          const styles = {
            fill: highlightStyles.fillColor,
            "fill-opacity": String(highlightStyles.fillOpacity),
            "mix-blend-mode": "normal",
            stroke: "none",
            "stroke-opacity": "0",
          } as Record<string, string>;
          r.annotations.add(
            "highlight",
            hl.cfiRange,
            {},
            () => {
              new Notice(`打开反链：${hl.display}`);
              onOpenNote(hl.sourceFile);
            },
            "epubjs-backlink-hl",
            styles
          );
          addedBacklinkCfisRef.current.push(hl.cfiRange);
        } catch (err) {
          console.debug("[super-epub] add highlight error:", err);
        }
      }
    },
    [highlightStyles, onOpenNote]
  );

  useEffect(() => {
    highlightsRef.current = highlights;
  }, [highlights]);

  // #3: Merged duplicate highlight effects into a single unified effect
  useEffect(() => {
    selectionColorRef.current = highlightStyles.selectionColor;
    const r = renditionRef.current;
    if (!r) return;

    const contents: any = (r as any)?.getContents?.();
    const list = Array.isArray(contents) ? contents : contents ? [contents] : [];
    for (const c of list) {
      applySelectionStyle(c, selectionColorRef.current);
      applyBacklinkStyle(c);
      applyReadingLayoutStyle(c);
    }
  }, [highlightStyles, applySelectionStyle, applyBacklinkStyle, applyReadingLayoutStyle]);

  // #3: Single unified effect for rendition + highlights + typography
  useEffect(() => {
    if (!rendition) return;
    applyTypography(rendition);

    let cancelled = false;
    const run = async () => {
      const ready = (rendition as any)?.book?.ready;
      if (ready && typeof ready.then === "function") {
        try {
          await ready;
        } catch (err) {
          console.debug("[super-epub] book.ready error:", err);
        }
      }
      if (cancelled) return;
      applyBacklinkHighlights(rendition, highlights);
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [rendition, highlights, highlightStyles, applyTypography, applyBacklinkHighlights]);

  // --- Rendition event handlers ---

  useEffect(() => {
    if (!rendition) return;

    const handleRelocated = () => {
      dismissToolbar();
      onUserActivity?.();
    };
    const handleRendered = () => {
      applyBacklinkHighlights(rendition, highlightsRef.current);
    };

    const hook = (c: Contents) => {
      try {
        applySelectionStyle(c, selectionColorRef.current);
        applyBacklinkStyle(c);
        applyReadingLayoutStyle(c);
      } catch (err) {
        console.debug("[super-epub] content hook error:", err);
      }
    };

    rendition.on("selected", onSelected);
    rendition.on("click", handleToolbarClick);
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
      rendition.off("click", handleToolbarClick);
      rendition.off("relocated", handleRelocated);
      rendition.off("rendered", handleRendered);
      contentHook?.unregister?.(hook);
    };
  }, [
    rendition,
    onSelected,
    handleToolbarClick,
    applyBacklinkHighlights,
    applySelectionStyle,
    applyBacklinkStyle,
    applyReadingLayoutStyle,
    onUserActivity,
    dismissToolbar,
  ]);

  const handleCopyLink = useCallback(async () => {
    if (!toolbar) return;

    let label = sanitizeLinkText(toolbar.text);
    if (!label) label = "引用";
    if (label.length > 60) label = label.slice(0, 60) + "...";

    const cfi64 = base64UrlEncode(toolbar.cfiRange);
    const link = `[[${file.path}#cfi64=${cfi64}|${label}]]`;

    try {
      await writeClipboard(link);
      new Notice("EPUB 链接已复制");
    } catch (err) {
      console.warn("[super-epub] Copy failed:", err);
      new Notice("复制失败");
    } finally {
      dismissToolbar();
      clearSelection();
    }
  }, [toolbar, file.path, writeClipboard, clearSelection, dismissToolbar]);

  const readerStyles = useMemo<IReactReaderStyle>(() => {
    return isDarkMode ? darkReaderTheme : lightReaderTheme;
  }, [isDarkMode]);

  // #16: Improved TOC toggle — uses ref-based approach instead of fragile DOM query
  const tocButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!onRegisterActions) return;
    const toggleToc = () => {
      // Try ref first, then fall back to container query
      if (tocButtonRef.current) {
        tocButtonRef.current.click();
        return;
      }
      const container = containerRef.current;
      if (!container) return;
      const buttons = Array.from(container.querySelectorAll("button"));
      const tocBtn = buttons.find((btn) => {
        const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").toLowerCase();
        if (label.includes("toc") || label.includes("contents") || label.includes("table of contents") || label.includes("目录")) {
          return true;
        }
        if (btn.textContent && btn.textContent.trim()) return false;
        const spans = btn.querySelectorAll("span");
        return spans.length === 2;
      });
      if (tocBtn) {
        tocButtonRef.current = tocBtn; // cache for next time
        tocBtn.click();
      }
    };
    onRegisterActions({ toggleToc });
  }, [onRegisterActions]);

  const toolbarNode = toolbar && toolbar.visible ? (
    <div
      ref={toolbarRef}
      className="epub-toolbar"
      style={{ left: toolbar.x, top: toolbar.y, position: "fixed" }}
      onMouseDown={(e) => e.preventDefault()} // keep selection until click
    >
      <button
        className="mod-cta epub-toolbar__button"
        onClick={handleCopyLink}
        aria-label="复制链接"
        title="复制链接"
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
    background: "#111",
  },
  tocButton: {
    ...ReactReaderStyle.tocButton,
    color: "#ddd",
  },
};
