import { WorkspaceLeaf, FileView, TFile, TFolder, Menu, moment } from "obsidian";
import * as React from "react";
import * as ReactDOM from "react-dom";
import type { EpubPluginSettings } from "../plugin/EpubPluginSettings";
import { EpubReader } from "../reader/EpubReader";
import { BacklinkManager, BacklinkHighlight } from "../services/BacklinkManager";
import { ReadingTracker } from "../services/ReadingTracker";
import { base64UrlDecode } from "../shared/utils";
import type { ReadingStats } from "../shared/models";

export const EPUB_FILE_EXTENSION = "epub";
export const VIEW_TYPE_EPUB = "epub";
export const ICON_EPUB = "doc-epub";

export interface ProgressStore {
  getProgress(bookPath: string): string | number | null | undefined;
  setProgress(bookPath: string, location: string | number): void;
}

// 扩展 ProgressStore 接口以包含 settings
export interface EpubPluginInstance extends ProgressStore {
  settings: EpubPluginSettings;
  getReadingStats: (bookPath: string) => ReadingStats;
  listReadingStats: () => Array<{ path: string; stats: ReadingStats }>;
  recordReadingSession: (bookPath: string) => void;
  addReadingTime: (bookPath: string, deltaMs: number) => void;
}

export class EpubView extends FileView {
  allowNoFile: false;

  private fileContent: ArrayBuffer | null = null;
  private jumpCfiRange: string | null = null;

  private readonly backlinkManager: BacklinkManager;
  private highlights: BacklinkHighlight[] = [];
  private highlightsKey: string | null = null;
  private refreshTimer: number | null = null;
  private backlinkListenerRegistered = false;
  private readonly backlinkDebounceMs = 4000;
  private backlinksDirty = false;
  private readonly readingTracker: ReadingTracker;
  private isActiveLeaf = false;
  private toggleTocAction: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: EpubPluginInstance
  ) {
    super(leaf);
    this.backlinkManager = new BacklinkManager(this.app);
    this.readingTracker = new ReadingTracker({
      getFilePath: () => this.file?.path ?? null,
      onFlush: (deltaMs, filePath) => this.plugin.addReadingTime(filePath, deltaMs),
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (activeLeaf) => {
        const nextActive = activeLeaf === this.leaf;
        if (this.isActiveLeaf !== nextActive) {
          this.isActiveLeaf = nextActive;
          this.readingTracker.setActiveLeaf(nextActive);
        }
      })
    );

    this.registerBacklinkRefresh();
  }

  // Keep your old menu: create a note file
  onPaneMenu(menu: Menu, source: "more-options" | "tab-header" | string): void {
    menu.addItem((item) => {
      item
        .setTitle("Create new epub note")
        .setIcon("document")
        .onClick(async () => {
          const fileName = this.getFileName();
          let file = this.app.vault.getAbstractFileByPath(fileName);
          if (file == null || !(file instanceof TFile)) {
            const folderPath = fileName.split("/").slice(0, -1).join("/");
            if (folderPath) {
              const folder = this.app.vault.getAbstractFileByPath(folderPath);
              if (!(folder instanceof TFolder)) {
                await this.app.vault.createFolder(folderPath);
              }
            }
            file = await this.app.vault.create(fileName, this.getFileContent());
          }
          const fileLeaf = this.app.workspace.createLeafBySplit(this.leaf);
          fileLeaf.openFile(file as TFile, { active: true });
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("目录")
        .setIcon("list")
        .onClick(() => {
          this.toggleTocAction?.();
        });
    });
    menu.addSeparator();
    super.onPaneMenu(menu, source);
  }

  private getFileName() {
    let filePath: string;
    const currentSettings = this.plugin.settings;
    if (currentSettings.useSameFolder) {
      filePath = `${this.file.parent.path}/`;
    } else {
      filePath = currentSettings.notePath.endsWith("/")
        ? currentSettings.notePath
        : `${currentSettings.notePath}/`;
    }
    return `${filePath}${this.file.basename}.md`;
  }

  private getFileContent() {
    const currentSettings = this.plugin.settings;
    return `---
Tags: ${currentSettings.tags}
Date: ${moment().toLocaleString()}
---

# ${this.file.basename}
`;
  }

  async onLoadFile(file: TFile): Promise<void> {
    ReactDOM.unmountComponentAtNode(this.contentEl);
    this.contentEl.empty();

    // Load EPUB binary
    this.fileContent = await this.app.vault.readBinary(file);

    this.readingTracker.stop();
    const activeLeaf =
      // @ts-ignore - older obsidian typings
      (this.app.workspace as any).getActiveLeaf?.() ?? this.app.workspace.activeLeaf;
    this.isActiveLeaf = activeLeaf === this.leaf;
    this.plugin.recordReadingSession(file.path);
    this.readingTracker.setActiveLeaf(this.isActiveLeaf);
    this.readingTracker.start();

    // Initial backlinks (MVP)
    this.highlights = this.backlinkManager.getHighlightsForBook(file);
    this.highlightsKey = this.getHighlightsKey(this.highlights);

    // If leaf already has ephemeral state
    const maybeEState =
      // @ts-ignore
      (this.leaf as any).getEphemeralState?.() ??
      // @ts-ignore
      (this.leaf as any).viewState?.eState;

    if (maybeEState?.cfi64) {
      this.handleJumpFromCfi64(String(maybeEState.cfi64));
    }

    this.renderReader();
  }

  // Receive jump
  async setEphemeralState(state: any): Promise<void> {
    if (!state) return;

    if (state.cfi64) {
      this.handleJumpFromCfi64(String(state.cfi64));
      return;
    }

    if (typeof state.subpath === "string") {
      const m = state.subpath.match(/#?cfi64=([A-Za-z0-9_-]+)/);
      if (m?.[1]) this.handleJumpFromCfi64(m[1]);
    }
  }

  private handleJumpFromCfi64(encoded: string): void {
    try {
      this.jumpCfiRange = base64UrlDecode(encoded);
      this.renderReader();
    } catch {
      // ignore
    }
  }

  renderReader(): void {
    if (!this.file || !this.fileContent) return;

    // Read progress from plugin data.json
    const initialLocation = this.plugin.getProgress(this.file.path) ?? 0;

    // 使用插件的最新设置而不是初始设置
    const currentSettings = this.plugin.settings;

    const wrapperStyle: React.CSSProperties = {
      height: "100%",
      boxSizing: "border-box",
      overflow: "hidden",
    };

    ReactDOM.render(
      <div style={wrapperStyle}>
          <EpubReader
            app={this.app}
            file={this.file}
            contents={this.fileContent}
            title={this.file.basename}
            scrolled={currentSettings.scrolledView}
            highlightColor={currentSettings.highlightColor}
            highlightOpacity={currentSettings.highlightOpacity}
            fontSizePercent={currentSettings.fontSizePercent}
            followObsidianTheme={currentSettings.followObsidianTheme}
            followObsidianFont={currentSettings.followObsidianFont}
            initialLocation={initialLocation}
            jumpCfiRange={this.jumpCfiRange}
            highlights={this.highlights}
            onLocationChange={(loc: string | number) => {
              if (!this.file) return;
              this.plugin.setProgress(this.file.path, loc);
            }}
            onOpenNote={(note: TFile) => {
              const leaf = this.app.workspace.getLeaf("split", "vertical") ?? this.app.workspace.getLeaf(false);
              leaf.openFile(note);
            }}
            onUserActivity={() => {
              this.readingTracker.recordActivity();
            }}
            onRegisterActions={({ toggleToc }) => {
              this.toggleTocAction = toggleToc;
            }}
          />
      </div>,
      this.contentEl
    );

    // consume jump (one shot)
    this.jumpCfiRange = null;
  }

  private getHighlightsKey(list: BacklinkHighlight[]): string {
    return list.map((h) => `${h.cfiRange}|${h.sourceFile.path}`).join("\n");
  }

  onunload(): void {
    this.readingTracker.stop();
    ReactDOM.unmountComponentAtNode(this.contentEl);
  }

  getDisplayText() {
    return this.file ? this.file.basename : "No File";
  }

  canAcceptExtension(extension: string) {
    return extension == EPUB_FILE_EXTENSION;
  }

  getViewType() {
    return VIEW_TYPE_EPUB;
  }

  getIcon() {
    return ICON_EPUB;
  }

  private registerBacklinkRefresh(): void {
    if (this.backlinkListenerRegistered) return;
    this.backlinkListenerRegistered = true;
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (!this.file || !file) return;
        // Any markdown change might add/remove backlinks to the current book.
        if (file.extension === "md") {
          this.backlinksDirty = true;
        }
        if (file.path === this.file.path) {
          this.backlinksDirty = true;
        }
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (!this.file || !this.backlinksDirty) return;
        this.backlinksDirty = false;
        this.scheduleBacklinkRefresh();
      })
    );
  }

  private scheduleBacklinkRefresh(): void {
    if (!this.file) return;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (!this.file) return;
      const next = this.backlinkManager.getHighlightsForBook(this.file);
      const nextKey = this.getHighlightsKey(next);
      if (nextKey === this.highlightsKey) return;
      this.highlights = next;
      this.highlightsKey = nextKey;
      this.renderReader();
    }, this.backlinkDebounceMs);
  }
}
