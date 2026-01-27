type ReadingTrackerOptions = {
  getFilePath: () => string | null;
  onFlush: (deltaMs: number, filePath: string) => void;
  tickIntervalMs?: number;
  flushThresholdMs?: number;
  maxTickMs?: number;
  activityTimeoutMs?: number;
};

export class ReadingTracker {
  private readTimer: number | null = null;
  private readTimePendingMs = 0;
  private lastTickAt = 0;
  private isActiveLeaf = false;
  private readonly tickIntervalMs: number;
  private readonly flushThresholdMs: number;
  private readonly maxTickMs: number;
  private readonly activityTimeoutMs: number;
  private lastActivityAt = 0;

  constructor(private readonly options: ReadingTrackerOptions) {
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
    this.flushThresholdMs = options.flushThresholdMs ?? 5000;
    this.maxTickMs = options.maxTickMs ?? 5000;
    this.activityTimeoutMs = options.activityTimeoutMs ?? 60000;
  }

  setActiveLeaf(isActive: boolean): void {
    if (this.isActiveLeaf !== isActive) {
      this.isActiveLeaf = isActive;
      this.lastTickAt = Date.now();
      if (!isActive) this.flush();
    }
  }

  start(): void {
    this.lastTickAt = Date.now();
    if (this.readTimer) window.clearInterval(this.readTimer);
    this.readTimer = window.setInterval(() => this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.readTimer) {
      window.clearInterval(this.readTimer);
      this.readTimer = null;
    }
    this.flush();
    this.readTimePendingMs = 0;
    this.lastTickAt = 0;
  }

  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  flush(): void {
    const filePath = this.options.getFilePath();
    if (!filePath) return;
    if (this.readTimePendingMs <= 0) return;
    this.options.onFlush(this.readTimePendingMs, filePath);
    this.readTimePendingMs = 0;
  }

  private tick(): void {
    const filePath = this.options.getFilePath();
    if (!filePath) return;

    const now = Date.now();
    const last = this.lastTickAt || now;
    this.lastTickAt = now;

    if (!this.isActiveLeaf) return;
    if (!this.lastActivityAt) return;
    if (now - this.lastActivityAt > this.activityTimeoutMs) return;

    const delta = now - last;
    if (delta <= 0) return;
    const capped = Math.min(delta, this.maxTickMs);
    this.readTimePendingMs += capped;
    if (this.readTimePendingMs >= this.flushThresholdMs) {
      this.flush();
    }
  }
}
