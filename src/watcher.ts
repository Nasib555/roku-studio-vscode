import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Watches the app folder and fires a debounced callback after saves.
 * Off unless explicitly enabled: each trigger is a full package upload.
 */
export class DeployWatcher implements vscode.Disposable {
  private watcher?: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private appDir?: string;

  constructor(
    private readonly debounceMs: () => number,
    private readonly onTrigger: (reason: string) => void
  ) {}

  get active(): boolean {
    return !!this.watcher;
  }

  start(appDir: string): void {
    this.stop();
    this.appDir = appDir;
    // Watch the app folder itself rather than the workspace, so edits to the
    // extension's own files or docs don't trigger a 3 MB upload.
    const pattern = new vscode.RelativePattern(appDir, '**/*.{brs,xml,json,png,jpg,jpeg,txt,csv}');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher = watcher;

    const schedule = (uri: vscode.Uri) => {
      const name = path.basename(uri.fsPath);
      if (name === '.DS_Store' || name === 'manifest') {
        // The deploy itself rewrites the manifest; reacting to that would loop.
        return;
      }
      if (this.timer) { clearTimeout(this.timer); }
      this.timer = setTimeout(() => this.onTrigger(name), Math.max(200, this.debounceMs()));
    };

    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
  }

  /** Re-point at a new folder if one is already being watched. */
  retarget(appDir: string): void {
    if (this.active && this.appDir !== appDir) {
      this.start(appDir);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
