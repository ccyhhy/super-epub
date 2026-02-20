import { App, TFile } from "obsidian";
import { base64UrlDecode } from "../shared/utils";

export type BacklinkHighlight = {
  cfiRange: string;   // decoded epubcfi range
  sourceFile: TFile;  // note file that contains the link
  display: string;    // display label
};

/**
 * Manages backlink discovery for EPUB books.
 * #5: Added result caching — results are reused if the underlying metadata
 * hasn't changed (measured by a cheap hash of candidate count + resolved links).
 */
export class BacklinkManager {
  private lastBookPath: string | null = null;
  private lastCacheKey: string | null = null;
  private cachedResults: BacklinkHighlight[] = [];

  constructor(private readonly app: App) { }

  /**
   * MVP: only parse backlinks pointing to the current book.
   * 1) coarse filter using resolvedLinks (source->dest counts)
   * 2) fine parse using getFileCache(file).links/embeds and resolve target
   */
  getHighlightsForBook(bookFile: TFile, limit = 200): BacklinkHighlight[] {
    const bookPath = bookFile.path;
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const backlinksApi = (this.app.metadataCache as any).getBacklinksForFile?.(bookFile);
    const cfiRegex = /#cfi64=([A-Za-z0-9_-]+)/g;

    // coarse candidates
    const candidates: TFile[] = [];
    if (backlinksApi?.data) {
      const data: any = backlinksApi.data;
      if (typeof data?.keys === "function") {
        for (const sourcePath of data.keys()) {
          const af = this.app.vault.getAbstractFileByPath(sourcePath);
          if (af instanceof TFile) candidates.push(af);
        }
      } else {
        for (const sourcePath of Object.keys(data)) {
          const af = this.app.vault.getAbstractFileByPath(sourcePath);
          if (af instanceof TFile) candidates.push(af);
        }
      }
    }

    if (!candidates.length) {
      for (const [sourcePath, destCounts] of Object.entries(resolvedLinks)) {
        if (!destCounts) continue;
        if (!Object.prototype.hasOwnProperty.call(destCounts, bookPath)) continue;

        const af = this.app.vault.getAbstractFileByPath(sourcePath);
        if (af instanceof TFile) candidates.push(af);
      }
    }

    // #5: Build cache key from candidate paths + mtimes to detect changes
    const cacheKey = this.buildCacheKey(bookPath, candidates);
    if (this.lastBookPath === bookPath && this.lastCacheKey === cacheKey) {
      return this.cachedResults;
    }

    const seenEncoded = new Set<string>();
    const results: BacklinkHighlight[] = [];

    for (const sourceFile of candidates) {
      const cache = this.app.metadataCache.getFileCache(sourceFile);
      if (!cache) continue;

      const items = [...(cache.links ?? []), ...(cache.embeds ?? [])];
      if (!items.length) continue;

      for (const item of items) {
        const linkRaw = String((item as any).link ?? "");
        const linkPath = linkRaw.split("#")[0];
        let resolvedPath = linkPath;

        if (!resolvedPath) {
          const original = String((item as any).original ?? "");
          const wikiMatch = original.match(/\[\[([^|\]]+)/);
          if (wikiMatch?.[1]) resolvedPath = wikiMatch[1].split("#")[0];
        }

        // resolve the link target precisely
        const dest = this.app.metadataCache.getFirstLinkpathDest(resolvedPath, sourceFile.path);
        if (!dest || dest.path !== bookFile.path) continue;

        const original = (item as any).original as string | undefined;
        const subpath = (item as any).subpath as string | undefined;
        const candidateStrings = [original, linkRaw, subpath].filter(Boolean) as string[];
        const hasCfi = candidateStrings.some((v) => v.indexOf("#cfi64=") !== -1);
        if (!hasCfi) continue;

        const display = String((item as any).displayText ?? sourceFile.basename);

        for (const raw of candidateStrings) {
          cfiRegex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = cfiRegex.exec(raw)) !== null) {
            const encoded = m[1];
            if (!encoded) continue;
            if (seenEncoded.has(encoded)) continue;
            seenEncoded.add(encoded);

            try {
              const cfiRange = base64UrlDecode(encoded);
              results.push({ cfiRange, sourceFile, display });
              if (results.length >= limit) {
                this.updateCache(bookPath, cacheKey, results);
                return results;
              }
            } catch (err) {
              console.debug("[super-epub] Invalid cfi64 payload:", err);
            }
          }
        }
      }
    }

    this.updateCache(bookPath, cacheKey, results);
    return results;
  }

  /** Build a cheap hash key from candidate paths and their modification times */
  private buildCacheKey(bookPath: string, candidates: TFile[]): string {
    // Sort for determinism; include mtime for change detection
    const parts = candidates
      .map((f) => `${f.path}:${f.stat.mtime}`)
      .sort()
      .join("|");
    return `${bookPath}::${candidates.length}::${parts}`;
  }

  private updateCache(bookPath: string, cacheKey: string, results: BacklinkHighlight[]): void {
    this.lastBookPath = bookPath;
    this.lastCacheKey = cacheKey;
    this.cachedResults = results;
  }
}
