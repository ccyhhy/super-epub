import { useEffect, useState } from "react";

export type ObsidianTypography = {
  fontFamily: string;
  fontSize: string;
};

function readCssVar(el: HTMLElement, name: string): string | null {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v ? v : null;
}

function readObsidianTypography(): ObsidianTypography {
  const body = document.body;
  const root = document.documentElement;
  const bodyStyle = getComputedStyle(body);
  const rootStyle = getComputedStyle(root);

  const fontFamily =
    readCssVar(body, "--font-text") ||
    readCssVar(root, "--font-text") ||
    bodyStyle.fontFamily ||
    rootStyle.fontFamily ||
    "";

  const fontSize =
    readCssVar(body, "--font-text-size") ||
    readCssVar(root, "--font-text-size") ||
    bodyStyle.fontSize ||
    rootStyle.fontSize ||
    "";

  return { fontFamily, fontSize };
}

export function useObsidianTypography(followFont: boolean): ObsidianTypography {
  const [typography, setTypography] = useState<ObsidianTypography>(() => readObsidianTypography());

  useEffect(() => {
    if (!followFont) return;

    const update = () => {
      const next = readObsidianTypography();
      setTypography((prev) => {
        if (prev.fontFamily === next.fontFamily && prev.fontSize === next.fontSize) return prev;
        return next;
      });
    };

    update();

    const body = document.body;
    const root = document.documentElement;
    const head = document.head;
    const observer = new MutationObserver(() => update());
    observer.observe(body, { attributes: true, attributeFilter: ["class", "style"] });
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    observer.observe(head, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [followFont]);

  return typography;
}
