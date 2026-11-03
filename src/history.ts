import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export interface HistoryEntry {
  id: string;
  file: string;
  timestamp: number;
  sizeBytes: number;
  buildVersion?: string;
  deviceName: string;
  ip: string;
}

const KEY = 'rokuStudio.history';

/**
 * Keeps the last N deployed packages on disk so a known-good build can go back
 * on the device without rebuilding from a changed working tree.
 */
export class DeployHistory {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly maxEntries: () => number
  ) {}

  /** Directory for retained packages; created on demand. */
  dir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'packages');
  }

  list(): HistoryEntry[] {
    return this.context.globalState
      .get<HistoryEntry[]>(KEY, [])
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async record(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
    const all = [{ ...entry, id: `${entry.timestamp}` }, ...this.list()];
    const keep = all.slice(0, Math.max(1, this.maxEntries()));
    const drop = all.slice(keep.length);

    // Remove the package files that fell out of the window.
    await Promise.all(drop.map((e) => fs.rm(e.file, { force: true })));
    await this.context.globalState.update(KEY, keep);
  }

  /** Drop entries whose package file is gone, so the list matches disk. */
  async prune(): Promise<HistoryEntry[]> {
    const entries = this.list();
    const alive: HistoryEntry[] = [];
    for (const entry of entries) {
      try {
        await fs.access(entry.file);
        alive.push(entry);
      } catch {
        // File removed outside the extension; forget the entry.
      }
    }
    if (alive.length !== entries.length) {
      await this.context.globalState.update(KEY, alive);
    }
    return alive;
  }

  async clear(): Promise<void> {
    for (const entry of this.list()) {
      await fs.rm(entry.file, { force: true });
    }
    await this.context.globalState.update(KEY, []);
  }
}

export function describeEntry(entry: HistoryEntry): string {
  const when = new Date(entry.timestamp);
  const stamp = when.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const version = entry.buildVersion ? `build ${entry.buildVersion}` : 'unknown build';
  return `${stamp} · ${version} · ${(entry.sizeBytes / 1024).toFixed(0)} KB`;
}

export interface ScreenshotFile {
  file: string;
  name: string;
  timestamp: number;
  sizeBytes: number;
}

/**
 * Manages the screenshots folder: listing, trimming to a cap, and clearing.
 * Captures accumulate quickly once live preview is used, so they are pruned
 * on a cap rather than kept forever.
 */
export class ScreenshotStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly limit: () => number
  ) {}

  dir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'screenshots');
  }

  async list(): Promise<ScreenshotFile[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir());
    } catch {
      return [];
    }
    const out: ScreenshotFile[] = [];
    for (const name of names) {
      if (!/\.(jpg|jpeg|png)$/i.test(name)) { continue; }
      const file = path.join(this.dir(), name);
      try {
        const stat = await fs.stat(file);
        out.push({ file, name, timestamp: stat.mtimeMs, sizeBytes: stat.size });
      } catch {
        // Vanished between readdir and stat; skip it.
      }
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Delete the oldest files beyond the configured cap. Returns how many went. */
  async prune(): Promise<number> {
    const cap = this.limit();
    if (cap <= 0) { return 0; }
    const files = await this.list();
    const excess = files.slice(cap);
    await Promise.all(excess.map((f) => fs.rm(f.file, { force: true })));
    return excess.length;
  }

  async clear(): Promise<number> {
    const files = await this.list();
    await Promise.all(files.map((f) => fs.rm(f.file, { force: true })));
    return files.length;
  }

  async totalBytes(): Promise<number> {
    return (await this.list()).reduce((sum, f) => sum + f.sizeBytes, 0);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
