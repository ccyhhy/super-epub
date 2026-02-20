import { useMemo } from "react";
import { parseColorComponents } from "../../shared/utils";

const DEFAULT_HIGHLIGHT_COLOR = "#ffd700";

export type HighlightStyles = {
    fillColor: string;
    fillOpacity: number;
    selectionColor: string;
    cornerRadius: number;
};

/**
 * Computes highlight style values from user settings.
 * Extracted from EpubReader for separation of concerns (#7).
 */
export function useHighlightStyles(
    highlightColor: string,
    highlightOpacity: number
): HighlightStyles {
    return useMemo(() => {
        const { r, g, b, alpha } = parseColorComponents(highlightColor, DEFAULT_HIGHLIGHT_COLOR);
        const baseOpacity = (highlightOpacity / 100) * alpha;
        const fillColor = `rgb(${r}, ${g}, ${b})`;
        const selectionOpacity = Math.min(0.5, baseOpacity * 0.5);
        const fillOpacity = selectionOpacity;
        const selectionColor = `rgba(${r}, ${g}, ${b}, ${selectionOpacity})`;
        const cornerRadius = 2;
        return { fillColor, fillOpacity, selectionColor, cornerRadius };
    }, [highlightColor, highlightOpacity]);
}
