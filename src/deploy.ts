
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import archiver = require('archiver');
import { parseInstallErrors, ParsedLocation } from './parse';

export interface DeployOptions {
  appDir: string;
  ip: string;
  user: string;
  password: string;
  bumpManifest: boolean;
  bumpBuildVersion: boolean;
  /**
   * Uninstall the dev channel before installing. This ERASES the channel's
   * registry (saved settings, playlists...). Off by default.
   */
  wipeData?: boolean;
  /** When set, the built package is copied here instead of being deleted. */
  archiveTo?: string;
  log: (line: string) => void;
}

export interface DeployResult {
  problems: ParsedLocation[];
  /** Path of the retained package, when archiveTo was given. */
  archivedPath?: string;
  buildVersion?: string;
}

export class DeployError extends Error {
  constructor(message: string, readonly problems: ParsedLocation[] = []) {
    super(message);
    this.name = 'DeployError';
  }
}

function run(
  cmd: string,
  args: string[],
  stdin?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    if (stdin !== undefined) {
      child.stdin.on('error', () => { /* curl may exit before reading */ });
      child.stdin.end(stdin);
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Increment build_version so the version shown on-device identifies the build. */
async function bumpBuildVersion(appDir: string, log: (s: string) => void): Promise<string | undefined> {
  const manifestPath = path.join(appDir, 'manifest');
  if (!await exists(manifestPath)) { return undefined; }

  const original = await fs.readFile(manifestPath, 'utf8');
  const match = /^([ \t]*build_version[ \t]*=[ \t]*)(\d+)([ \t]*)$/im.exec(original);
  if (!match) {
    log('! no numeric build_version line found, skipping increment');
    return undefined;
  }
  const next = String(parseInt(match[2], 10) + 1);
  const updated = original.replace(match[0], `${match[1]}${next}${match[3]}`);
  await fs.writeFile(manifestPath, updated, 'utf8');
  log(`• build_version ${match[2]} → ${next}`);
  return next;
}

async function readBuildVersion(appDir: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(appDir, 'manifest'), 'utf8');
    return /^[ \t]*build_version[ \t]*=[ \t]*(\d+)/im.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Build the channel package in-process.
 *
 * Uses archiver rather than shelling out to `zip`, which is absent on Windows
 * and not guaranteed on a minimal Linux image. The manifest bump happens only
 * inside the archive; the manifest on disk is never touched.
 */
async function zipApp(appDir: string, bump: boolean, log: (s: string) => void): Promise<string> {
  const zipPath = path.join(os.tmpdir(), `roku-studio-${Date.now()}.zip`);
  log(`• zipping ${appDir}`);

  let manifestText: string | undefined;
  try {
    manifestText = await fs.readFile(path.join(appDir, 'manifest'), 'utf8');
  } catch {
    log('! manifest not found at the app root');
  }

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    // A missing optional file should not abort the whole package.
    archive.on('warning', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        log(`! ${err.message}`);
      } else {
        reject(err);
      }
    });

    archive.pipe(output);
    archive.glob('**/*', {
      cwd: appDir,
      dot: true,
      ignore: [
        '**/.DS_Store', '**/*.DS_Store', '__MACOSX/**', '**/__MACOSX/**',
        '.git/**', '**/Thumbs.db', 'out/**',
        ...(manifestText !== undefined ? ['manifest'] : [])
      ]
    });
    if (manifestText !== undefined) {
      let body = manifestText;
      if (bump) {
        // Terminate an unterminated last line first, then add the blank line.
        if (body.length > 0 && !body.endsWith('\n')) { body += '\n'; }
        body += '\n';
        log('• manifest bumped inside the package (blank line appended)');
      }
      archive.append(body, { name: 'manifest', date: new Date() });
    }
    void archive.finalize();
  });

  const { size } = await fs.stat(zipPath);
  if (size === 0) {
    throw new DeployError(`Package came out empty. Is ${appDir} the folder holding the manifest?`);
  }
  log(`• package built: ${(size / 1024).toFixed(0)} KB`);
  return zipPath;
}

const HTTP_MARK = '\n__HTTP_STATUS__';

/** Credentials go through a curl config on stdin so they never show up in the process list. */
function curlConfig(user: string, password: string): string {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `user = "${esc(user)}:${esc(password)}"\n`;
}

function curlArgs(extra: string[]): string[] {
  return [
    '--silent',
    '--show-error',
    '--digest',
    '--config', '-',
    '--max-time', '120',
    '--write-out', `${HTTP_MARK}%{http_code}`,
    ...extra
  ];
}

interface HttpReply { status: number; body: string }

async function post(
  ip: string, user: string, password: string, form: string[]
): Promise<HttpReply> {
  const args = curlArgs([...form.flatMap((f) => ['--form', f]), `http://${ip}/plugin_install`]);
  const res = await run('curl', args, curlConfig(user, password));
  if (res.code !== 0) {
    throw new DeployError(curlFailure(res.code, res.stderr, ip));
  }
  const at = res.stdout.lastIndexOf(HTTP_MARK);
  const status = at >= 0 ? parseInt(res.stdout.slice(at + HTTP_MARK.length), 10) : 0;
  const body = at >= 0 ? res.stdout.slice(0, at) : res.stdout;
  if (status === 401 || status === 403) {
    throw new DeployError(`Device rejected the credentials (HTTP ${status}). Check the dev password.`);
  }
  if (status !== 200) {
    throw new DeployError(`Roku returned HTTP ${status || 'no status'} from /plugin_install.`);
  }
  return { status, body };
}

function curlFailure(code: number, stderr: string, ip: string): string {
  switch (code) {
    case 6: return `Cannot resolve ${ip}. Check the IP address.`;
    case 7: return `Connection refused by ${ip}. Is developer mode enabled on the Roku?`;
    case 28: return `Timed out talking to ${ip}. Check the IP, that the Roku is awake and on the same network.`;
    case 35: case 52: case 56:
      return `Connection to ${ip} dropped during the request (${stderr.trim() || `curl exit ${code}`}).`;
    default: return `Request to ${ip} failed: ${stderr.trim() || `curl exit ${code}`}`;
  }
}

interface RokuMessage { text: string; type: string }

/** The page embeds: params = JSON.parse('{"messages":[{"text":"...","type":"..."}], ...}') */
export function parseMessages(body: string): RokuMessage[] | undefined {
  const m = /JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec(body);
  if (!m) { return undefined; }
  const attempts = [
    // Undo the JS string-literal layer, then parse the JSON inside.
    () => m[1].replace(/\\(['"\\/])/g, '$1'),
    () => m[1].replace(/\\'/g, "'"),
    () => m[1]
  ];
  for (const make of attempts) {
    try {
      const parsed = JSON.parse(make()) as { messages?: { text?: unknown; type?: unknown }[] };
      if (Array.isArray(parsed.messages)) {
        return parsed.messages.map((x) => ({ text: String(x.text ?? ''), type: String(x.type ?? 'info') }));
      }
    } catch { /* try the next unescaping */ }
  }
  return undefined;
}

/** Roku's install endpoint returns HTTP 200 with the outcome spelled out in the page. */
function installError(body: string, messages: RokuMessage[] | undefined, log: (s: string) => void): string | undefined {
  const bad = /Identical to previous version|Install Failure|Compilation Failed|Compile Failed|Failed to|Failure/i;

  if (messages) {
    for (const msg of messages) { log(`  roku: ${msg.text}`); }
    const failed = messages.filter((x) => x.type === 'error' || bad.test(x.text));
    if (failed.length) {
      return failed.map((x) => x.text).join(' | ');
    }
    if (messages.some((x) => /Install Success/i.test(x.text))) { return undefined; }
    return `Roku did not confirm the install: ${messages.map((x) => x.text).join(' | ') || 'no messages'}`;
  }

  // Older firmware without the embedded JSON: fall back to scraping the HTML.
  const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const hit = bad.exec(plain) ?? /Error:/i.exec(plain);
  if (hit) { return plain.slice(Math.max(0, hit.index), hit.index + 300); }
  return undefined;
}

/** Upload an already-built package. Shared by deploy() and history redeploys. */
export async function install(
  zipPath: string,
  ip: string,
  user: string,
  password: string,
  log: (s: string) => void,
  wipeData = false
): Promise<ParsedLocation[]> {
  if (wipeData) {
    log(`• uninstalling previous build on ${ip} (wipeDataOnDeploy: registry will be erased)`);
    await post(ip, user, password, ['mysubmit=Delete', 'archive=']);
  }

  log(`• installing on ${ip}`);
  // "Replace" swaps the package in place and keeps the registry.
  const res = await post(ip, user, password, ['mysubmit=Replace', `archive=@${zipPath}`]);

  const messages = parseMessages(res.body);
  const problems = parseInstallErrors(res.body);
  const problem = installError(res.body, messages, log);
  if (problem) {
    throw new DeployError(problem, problems);
  }
  if (problems.length) {
    log(`! ${problems.length} compile problem${problems.length === 1 ? '' : 's'} reported`);
  }
  log('✓ deployment complete');
  return problems;
}

export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const { appDir, ip, user, password, log } = opts;

  if (!await exists(appDir)) {
    throw new DeployError(`App directory does not exist: ${appDir}`);
  }

  let buildVersion: string | undefined;
  if (opts.bumpBuildVersion) {
    buildVersion = await bumpBuildVersion(appDir, log);
  }
  if (!buildVersion) {
    buildVersion = await readBuildVersion(appDir);
  }

  const zipPath = await zipApp(appDir, opts.bumpManifest, log);
  let archivedPath: string | undefined;

  try {
    const problems = await install(zipPath, ip, user, password, log, opts.wipeData);

    if (opts.archiveTo) {
      await fs.mkdir(opts.archiveTo, { recursive: true });
      archivedPath = path.join(opts.archiveTo, path.basename(zipPath));
      await fs.copyFile(zipPath, archivedPath);
    }
    return { problems, archivedPath, buildVersion };
  } finally {
    await fs.rm(zipPath, { force: true });
  }
}
