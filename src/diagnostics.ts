import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CrashScanner, ParsedLocation } from './parse';

export { CrashScanner, parseInstallErrors } from './parse';
export type { ParsedLocation } from './parse';

/** Map a device-side pkg:/ path back to a file in the local app folder. */
export function resolvePkgPath(appDir: string, pkgPath: string): string | undefined {
  const relative = pkgPath.replace(/^pkg:\/+/i, '').replace(/^\/+/, '');
  if (!relative) { return undefined; }
  const candidate = path.join(appDir, relative);
  try {
    fs.accessSync(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

function severityOf(problem: ParsedLocation): vscode.DiagnosticSeverity {
  return problem.isWarning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
}

/** Owns the Problems-panel entries for both compile errors and runtime crashes. */
export class ProblemReporter implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('roku');

  /** Replace all compile diagnostics with this set. */
  setCompileProblems(appDir: string, problems: ParsedLocation[]): number {
    this.collection.clear();
    return this.add(appDir, problems);
  }

  /** Add diagnostics without clearing, for crashes arriving over time. */
  add(appDir: string, problems: ParsedLocation[]): number {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    let placed = 0;

    for (const problem of problems) {
      const file = resolvePkgPath(appDir, problem.pkgPath);
      if (!file) { continue; }
      // Device line numbers are 1-based; VS Code ranges are 0-based.
      const lineIndex = Math.max(0, problem.line - 1);
      const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
      const diagnostic = new vscode.Diagnostic(range, problem.message, severityOf(problem));
      diagnostic.source = 'Roku';

      const existing = byFile.get(file) ?? [...(this.collection.get(vscode.Uri.file(file)) ?? [])];
      // Don't stack identical entries when a crash loop repeats.
      if (!existing.some((d) => d.range.start.line === lineIndex && d.message === problem.message)) {
        existing.push(diagnostic);
        placed++;
      }
      byFile.set(file, existing);
    }

    for (const [file, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(file), diagnostics);
    }
    return placed;
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

/** Re-exported so callers need not import parse.ts directly. */
export type { CrashScanner as CrashScannerType };
