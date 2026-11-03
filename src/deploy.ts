
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

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
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

/**
 * Append a newline to the manifest so the archive's bytes differ from the last
 * upload. Roku's installer skips a package it considers identical, which makes
 * a no-op redeploy look like it silently failed.
 */
async function bumpManifest(appDir: string, log: (s: string) => void): Promise<void> {
  const manifest = path.join(appDir, 'manifest');
  if (!await exists(manifest)) {
    log(`! manifest not found at ${manifest}, skipping bump`);
    return;
  }
  await fs.appendFile(manifest, '\n', 'utf8');
  log('• manifest bumped (blank line appended)');
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
 * and not guaranteed on a minimal Linux image.
 */
async function zipApp(appDir: string, log: (s: string) => void): Promise<string> {
  const zipPath = path.join(os.tmpdir(), `roku-studio-${Date.now()}.zip`);
  log(`• zipping ${appDir}`);

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
      ignore: ['**/.DS_Store', '__MACOSX/**', '.git/**', '**/Thumbs.db']
    });
    void archive.finalize();
  });

  const { size } = await fs.stat(zipPath);
  if (size === 0) {
    throw new DeployError(`Package came out empty. Is ${appDir} the folder holding the manifest?`);
  }
  log(`• package built: ${(size / 1024).toFixed(0)} KB`);
  return zipPath;
}

function curlArgs(user: string, password: string, extra: string[]): string[] {
  return [
    '--silent',
    '--show-error',
    '--digest',
    '--user', `${user}:${password}`,
    '--max-time', '120',
    ...extra
  ];
}

/** Roku's install endpoint returns HTTP 200 with the failure spelled out in the HTML body. */
function installError(body: string): string | undefined {
  const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/Identical to previous version/i.test(plain)) {
    return 'Roku rejected the package as identical to the installed one. Enable the manifest bump.';
  }
  const failure = /(Compile Failed|Install Failure|Failed to|Error:)([^.]*)/i.exec(plain);
  if (failure) { return failure[0].trim(); }
  if (/Application Received: Failure/i.test(plain)) { return plain.slice(0, 300); }
  return undefined;
}

/** Upload an already-built package. Shared by deploy() and history redeploys. */
export async function install(
  zipPath: string,
  ip: string,
  user: string,
  password: string,
  log: (s: string) => void
): Promise<ParsedLocation[]> {
  log(`• uninstalling previous build on ${ip}`);
  const del = await run('curl', curlArgs(user, password, [
    '--form', 'mysubmit=Delete',
    '--form', 'archive=',
    `http://${ip}/plugin_install`
  ]));
  if (del.code !== 0) {
    throw new DeployError(`uninstall request failed: ${del.stderr.trim() || `curl exit ${del.code}`}`);
  }
  if (/401 Unauthorized|HTTP Basic: Access denied/i.test(del.stdout)) {
    throw new DeployError('Device rejected the credentials. Check the dev password.');
  }

  log(`• installing on ${ip}`);
  const res = await run('curl', curlArgs(user, password, [
    '--form', 'mysubmit=Install',
    '--form', `archive=@${zipPath}`,
    '--form', 'passwd=',
    `http://${ip}/plugin_install`
  ]));
  if (res.code !== 0) {
    throw new DeployError(`install request failed: ${res.stderr.trim() || `curl exit ${res.code}`}`);
  }
  if (/401 Unauthorized|HTTP Basic: Access denied/i.test(res.stdout)) {
    throw new DeployError('Device rejected the credentials. Check the dev password.');
  }

  const problems = parseInstallErrors(res.stdout);
  const problem = installError(res.stdout);
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
  if (opts.bumpManifest) {
    await bumpManifest(appDir, log);
  }
  if (!buildVersion) {
    buildVersion = await readBuildVersion(appDir);
  }

  const zipPath = await zipApp(appDir, log);
  let archivedPath: string | undefined;

  try {
    const problems = await install(zipPath, ip, user, password, log);

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
