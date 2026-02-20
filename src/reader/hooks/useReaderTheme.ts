import { useCallback } from "react";
import type { Rendition } from "epubjs";

function readCssVar(el: HTMLElement, name: string): string | null {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v ? v : null;
}

/**
 * Provides theme and typography application helpers for the EPUB rendition.
 * Extracted from EpubReader for separation of concerns (#7).
 */
export function useReaderTheme(
    isDarkMode: boolean,
    followObsidianTheme: boolean,
    followObsidianFont: boolean,
    obsidianTypography: { fontFamily: string; fontSize: string },
    fontSizePercent: number,
    normalizedLineHeight: number
) {
    const getThemeColors = useCallback(() => {
        const body = document.body;
        const bodyStyle = getComputedStyle(body);
        const text =
            readCssVar(body, "--text-normal") ||
            bodyStyle.color ||
            (isDarkMode ? "#fff" : "#000");
        const background =
            readCssVar(body, "--background-primary") ||
            bodyStyle.backgroundColor ||
            (isDarkMode ? "#000" : "#fff");
        return {
            text: text.trim(),
            background: background.trim(),
        };
    }, [isDarkMode]);

    const updateTheme = useCallback(
        (rendition: Rendition) => {
            const themes = rendition.themes;
            if (followObsidianTheme) {
                const { text, background } = getThemeColors();
                themes.override("color", text || (isDarkMode ? "#fff" : "#000"));
                themes.override("background", background || (isDarkMode ? "#000" : "#fff"));
                return;
            }
            themes.override("color", isDarkMode ? "#fff" : "#000");
            themes.override("background", isDarkMode ? "#000" : "#fff");
        },
        [followObsidianTheme, getThemeColors, isDarkMode]
    );

    const applyFontSize = useCallback((rendition: Rendition, size: number) => {
        rendition.themes.fontSize(`${size}%`);
    }, []);

    const applyTypography = useCallback(
        (rendition: Rendition) => {
            const themes: any = rendition.themes;
            themes.override("line-height", String(normalizedLineHeight));
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
        [followObsidianFont, obsidianTypography, fontSizePercent, applyFontSize, normalizedLineHeight]
    );

    return { updateTheme, applyTypography };
}
