/**
 * Parsing of device output. Deliberately free of any vscode import so the MCP
 * server, which runs outside the editor, can share this code with the extension.
 */

export interface ParsedLocation {
  pkgPath: string;
  line: number;
  message: string;
  isWarning: boolean;
}

export function decodeHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:tr|div|p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Pull compile failures out of the plugin_install response body.
 * Roku reports these as HTTP 200 with the errors embedded in the HTML, in lines like:
 *   Compile error in pkg:/components/Home/HomeScreen.brs(214)
 *   --- Error: Syntax Error. (compile error &hbb) in pkg:/source/main.brs(12)
 */
export function parseInstallErrors(body: string): ParsedLocation[] {
  const text = decodeHtml(body);
  const problems: ParsedLocation[] = [];
  const seen = new Set<string>();

  const pattern = /(?:^|\n)([^\n]*?)(pkg:\/[^\s()'"]+?)\((\d+)(?:\s*:\s*\d+)?\)([^\n]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const before = match[1].trim();
    const pkgPath = match[2];
    const line = parseInt(match[3], 10);
    const after = match[4].trim();

    if (!/error|fail|warn|syntax|expected|unexpected|undefined|mismatch/i.test(`${before} ${after}`)) {
      continue;
    }
    const message = [before, after]
      .filter(Boolean)
      .join(' ')
      .replace(/^-+\s*/, '')
      // The path we just consumed often followed "... in", leaving it dangling.
      .replace(/\s+(?:in|at|from)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'Compile error';

    const key = `${pkgPath}:${line}:${message}`;
    if (seen.has(key)) { continue; }
    seen.add(key);

    problems.push({ pkgPath, line, message, isWarning: /warn/i.test(message) });
  }
  return problems;
}

/**
 * Accumulates debug-console text and extracts runtime crash locations.
 * Roku prints a crash as a block like:
 *   *** ERROR ***: Type Mismatch. ...
 *   Backtrace:
 *   #1  Function foo() As Void
 *       file/line: pkg:/components/Home/HomeScreen.brs(214)
 */
export class CrashScanner {
  private buffer = '';
  private pendingMessage?: string;

  /** Feed raw console output; returns any locations newly identified. */
  push(chunk: string): ParsedLocation[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Keep the last partial line for the next chunk.
    this.buffer = lines.pop() ?? '';

    const found: ParsedLocation[] = [];
    for (const raw of lines) {
      const line = raw.replace(/\r/g, '').trim();
      if (!line) { continue; }

      const errorHeader = /\*{3,}\s*(?:ERROR|Runtime error)[^:]*:?\s*(.*)$/i.exec(line);
      if (errorHeader) {
        this.pendingMessage = errorHeader[1].trim() || 'Runtime error';
        continue;
      }
      if (/^(?:BrightScript|Runtime) error/i.test(line)) {
        this.pendingMessage = line;
        continue;
      }

      const location = /(?:file\/line|Current Function|at)?\s*:?\s*(pkg:\/[^\s()'"]+?)\((\d+)\)/i.exec(line);
      if (location) {
        const message = this.pendingMessage ?? line.replace(location[0], '').trim();
        found.push({
          pkgPath: location[1],
          line: parseInt(location[2], 10),
          message: message || 'Runtime error reported here',
          isWarning: false
        });
        // One message belongs to the topmost frame only; deeper frames are context.
        this.pendingMessage = undefined;
      }
    }
    return found;
  }

  reset(): void {
    this.buffer = '';
    this.pendingMessage = undefined;
  }
}
