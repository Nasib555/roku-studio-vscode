/**
 * Package exclusion rules. No vscode import, so the MCP server shares it.
 *
 * Pattern syntax (gitignore-like, case-insensitive, "/" separators):
 *   name        matches a file or directory with that name at any depth
 *   dir/        matches directories only, at any depth
 *   /name       anchored: matches only at the app root
 *   * ? [..]    glob wildcards within a single path segment
 */

export const DEFAULT_EXCLUDES: string[] = [
  // macOS
  '.DS_Store', '._*', '__MACOSX/', '.Spotlight-V100/', '.Trashes/', '.fseventsd/',
  '* copy.*', '* copy [0-9]*.*',
  // Windows
  'Thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini',
  '$RECYCLE.BIN/', 'System Volume Information/', '*.lnk',
  '* - Copy.*', '* - Copy ([0-9]*).*',
  // Linux
  '*~', '.directory', '.Trash-*/', '.nfs*', '.fuse_hidden*',
  // Editors and tools
  '.idea/', '.vscode/', '.git/', '.gitignore', '.gitattributes', '.svn/',
  '*.swp', '*.swo', '*.tmp', '*.bak', '*.orig', '*.rej',
  // Build output (root only, so a component folder named "out" survives)
  '/out/'
];

interface Rule { re: RegExp; dirOnly: boolean; anchored: boolean }

function globToRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { out += '[^/]*'; }
    else if (c === '?') { out += '[^/]'; }
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end > 0) {
        out += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      } else { out += '\\['; }
    } else { out += c.replace(/[.+^${}()|\\\]]/g, '\\$&'); }
  }
  return out;
}

export function compileExcludes(patterns: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const raw of patterns) {
    let p = raw.trim().replace(/\\/g, '/');
    if (!p) { continue; }
    const anchored = p.startsWith('/');
    if (anchored) { p = p.slice(1); }
    const dirOnly = p.endsWith('/');
    if (dirOnly) { p = p.slice(0, -1); }
    if (!p) { continue; }
    rules.push({ re: new RegExp(`^${globToRegExp(p)}$`, 'i'), dirOnly, anchored });
  }
  return rules;
}

/** `rel` uses "/" separators and has no leading slash. Returns the matching pattern's source, if any. */
export function isExcluded(rules: Rule[], rel: string, isDir: boolean): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  // The manifest is the one file a channel cannot do without.
  if (rel.toLowerCase() === 'manifest') { return false; }
  const depth0 = !rel.includes('/');
  for (const r of rules) {
    if (r.dirOnly && !isDir) { continue; }
    if (r.anchored && !depth0) { continue; }
    if (r.re.test(name)) { return true; }
  }
  return false;
}

/** Files like "logo (1).png" are often real assets, so they are reported, never dropped. */
export function looksLikeDuplicate(rel: string): boolean {
  return /\s\(\d+\)(\.[^./]+)?$/.test(rel.slice(rel.lastIndexOf('/') + 1));
}

const TEXT_FILE = /(^|\/)manifest$|\.(brs|xml|json)$/i;

export function isScannedTextFile(rel: string): boolean {
  return TEXT_FILE.test(rel);
}

/** Static analysis rejects file:// URLs; return "path:line" for every occurrence. */
export function findFileUrls(rel: string, text: string): string[] {
  const hits: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/file:\/\//i.test(line)) { hits.push(`${rel}:${i + 1}`); }
  });
  return hits;
}
