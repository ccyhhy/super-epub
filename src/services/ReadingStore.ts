import { EpubPluginSettings, DEFAULT_SETTINGS } from "../plugin/EpubPluginSettings";
import type { ReadingStats } from "../shared/models";
import { normalizeProgressKey } from "../shared/utils";

type BookProgress = {
  location: string | number;
  updatedAt: number;
  totalReadTimeMs?: number;
  sessionCount?: number;
  lastOpenedAt?: number | null;
  lastReadAt?: number | null;
};

type PluginDataV1 = {
  version: 1;
  settings: EpubPluginSettings;
  progress: Record<string, BookProgress>;
};

type ReadingStoreOptions = {
  scheduleSave: () => void;
};

export class ReadingStore {
  private data: PluginDataV1 = {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    progress: {},
  };

  constructor(private readonly options: ReadingStoreOptions) {}

  load(raw: unknown): void {
    if (raw && typeof raw === "object" && (raw as any).version === 1) {
      const v1 = raw as PluginDataV1;
      this.data = {
        version: 1,
        settings: { ...DEFAULT_SETTINGS, ...(v1.settings ?? {}) },
        progress: v1.progress ?? {},
      };
      return;
    }

    const legacySettings = raw && typeof raw === "object" ? (raw as any) : {};
    this.data = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, ...legacySettings },
      progress: {},
    };
  }

  exportData(): PluginDataV1 {
    return {
      version: 1,
      settings: { ...this.data.settings },
      progress: this.data.progress,
    };
  }

  getSettings(): EpubPluginSettings {
    return this.data.settings;
  }

  setSettings(settings: EpubPluginSettings, scheduleSave = true): void {
    this.data.settings = settings;
    if (scheduleSave) this.options.scheduleSave();
  }

  getProgress(bookPath: string): string | number | null {
    const key = normalizeProgressKey(bookPath);
    return this.data.progress[key]?.location ?? null;
  }

  setProgress(bookPath: string, location: string | number): void {
    const entry = this.ensureBookProgress(bookPath);
    entry.location = location;
    entry.updatedAt = Date.now();
    this.options.scheduleSave();
  }

  getReadingStats(bookPath: string): ReadingStats {
    const entry = this.ensureBookProgress(bookPath);
    return {
      totalReadTimeMs: entry.totalReadTimeMs ?? 0,
      sessionCount: entry.sessionCount ?? 0,
      lastOpenedAt: entry.lastOpenedAt ?? null,
      lastReadAt: entry.lastReadAt ?? null,
    };
  }

  recordReadingSession(bookPath: string): void {
    const entry = this.ensureBookProgress(bookPath);
    entry.sessionCount = (entry.sessionCount ?? 0) + 1;
    entry.lastOpenedAt = Date.now();
    this.options.scheduleSave();
  }

  addReadingTime(bookPath: string, deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const entry = this.ensureBookProgress(bookPath);
    entry.totalReadTimeMs = (entry.totalReadTimeMs ?? 0) + deltaMs;
    entry.lastReadAt = Date.now();
    this.options.scheduleSave();
  }

  listReadingStats(): Array<{ path: string; stats: ReadingStats }> {
    return Object.entries(this.data.progress)
      .filter(([, entry]) => {
        const hasActivity =
          (entry.totalReadTimeMs ?? 0) > 0 ||
          (entry.sessionCount ?? 0) > 0 ||
          entry.lastOpenedAt != null ||
          entry.lastReadAt != null ||
          (entry.updatedAt ?? 0) > 0;
        return hasActivity;
      })
      .map(([path, entry]) => ({
        path,
        stats: {
          totalReadTimeMs: entry.totalReadTimeMs ?? 0,
          sessionCount: entry.sessionCount ?? 0,
          lastOpenedAt: entry.lastOpenedAt ?? null,
          lastReadAt: entry.lastReadAt ?? null,
        },
      }));
  }

  renameProgress(oldPath: string, newPath: string, isFolder: boolean): void {
    const oldKey = normalizeProgressKey(oldPath);
    const newKey = normalizeProgressKey(newPath);
    if (!oldKey || !newKey) return;

    if (isFolder) {
      const oldPrefix = oldKey.endsWith("/") ? oldKey : `${oldKey}/`;
      const newPrefix = newKey.endsWith("/") ? newKey : `${newKey}/`;
      const next: Record<string, BookProgress> = { ...this.data.progress };
      let changed = false;

      for (const [k, v] of Object.entries(this.data.progress)) {
        if (!k.startsWith(oldPrefix)) continue;
        const moved = newPrefix + k.slice(oldPrefix.length);
        if (!next[moved]) next[moved] = v;
        delete next[k];
        changed = true;
      }

      if (changed) {
        this.data.progress = next;
        this.options.scheduleSave();
      }
      return;
    }

    if (this.data.progress[oldKey] && !this.data.progress[newKey]) {
      this.data.progress[newKey] = this.data.progress[oldKey];
    }
    if (this.data.progress[oldKey]) {
      delete this.data.progress[oldKey];
      this.options.scheduleSave();
    }
  }

  private ensureBookProgress(bookPath: string): BookProgress {
    const key = normalizeProgressKey(bookPath);
    let entry = this.data.progress[key];
    if (!entry) {
      entry = {
        location: 0,
        updatedAt: 0,
        totalReadTimeMs: 0,
        sessionCount: 0,
        lastOpenedAt: null,
        lastReadAt: null,
      };
      this.data.progress[key] = entry;
      return entry;
    }

    if (entry.totalReadTimeMs == null) entry.totalReadTimeMs = 0;
    if (entry.sessionCount == null) entry.sessionCount = 0;
    if (entry.lastOpenedAt === undefined) entry.lastOpenedAt = null;
    if (entry.lastReadAt === undefined) entry.lastReadAt = null;
    return entry;
  }
}
