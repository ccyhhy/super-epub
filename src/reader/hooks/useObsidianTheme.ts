import { useEffect, useState } from "react";

export function useObsidianTheme(followTheme: boolean): boolean {
  const [isDarkMode, setIsDarkMode] = useState(() => document.body.classList.contains("theme-dark"));

  useEffect(() => {
    if (!followTheme) return;
    const body = document.body;
    const update = () => setIsDarkMode(body.classList.contains("theme-dark"));
    const observer = new MutationObserver(() => update());
    update();
    observer.observe(body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [followTheme]);

  return isDarkMode;
}
