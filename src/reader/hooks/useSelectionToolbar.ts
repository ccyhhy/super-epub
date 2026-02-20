import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Contents } from "epubjs";

export type ToolbarState = {
    visible: boolean;
    x: number;
    y: number;
    cfiRange: string;
    text: string;
};

/**
 * Manages the floating selection toolbar state and positioning.
 * Extracted from EpubReader for separation of concerns (#7).
 */
export function useSelectionToolbar(onUserActivity?: () => void) {
    const toolbarRef = useRef<HTMLDivElement | null>(null);
    const lastSelectionAtRef = useRef(0);

    const [toolbar, setToolbar] = useState<ToolbarState | null>(null);

    const dismissToolbar = useCallback(() => setToolbar(null), []);

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

        const x = absX;
        const y = absY;

        lastSelectionAtRef.current = Date.now();
        onUserActivity?.();
        setToolbar({ visible: true, x, y, cfiRange, text });
    }, [onUserActivity]);

    // Auto-adjust toolbar position to stay within viewport
    useLayoutEffect(() => {
        if (!toolbar?.visible) return;
        const el = toolbarRef.current;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        let nextX = toolbar.x;
        let nextY = toolbar.y;
        const margin = 8;

        if (rect.left < margin) nextX += margin - rect.left;
        if (rect.right > window.innerWidth - margin) {
            nextX -= rect.right - (window.innerWidth - margin);
        }
        if (rect.top < margin) nextY += margin - rect.top;
        if (rect.bottom > window.innerHeight - margin) {
            nextY -= rect.bottom - (window.innerHeight - margin);
        }

        if (Math.abs(nextX - toolbar.x) > 0.5 || Math.abs(nextY - toolbar.y) > 0.5) {
            setToolbar({ ...toolbar, x: nextX, y: nextY });
        }
    }, [toolbar]);

    const handleClick = useCallback(() => {
        const now = Date.now();
        if (now - lastSelectionAtRef.current < 200) return;
        setToolbar(null);
    }, []);

    return {
        toolbar,
        toolbarRef,
        setToolbar,
        dismissToolbar,
        onSelected,
        handleClick,
    };
}
