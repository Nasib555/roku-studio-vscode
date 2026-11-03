import { spawn } from 'child_process';
import * as http from 'http';

export const REMOTE_KEYS = [
  'Up', 'Down', 'Left', 'Right', 'Select',
  'Back', 'Home', 'Play', 'Rev', 'Fwd',
  'InstantReplay', 'Info', 'Backspace', 'Enter'
] as const;

export type RemoteKey = typeof REMOTE_KEYS[number];

function request(method: string, url: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          resolve(body);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Percent-encode a character for a Lit_ keypress.
 * encodeURIComponent leaves !'()*-._~ bare, and the device rejects some of
 * those in a path segment, so escape everything outside A-Za-z0-9.
 */
function encodeLiteral(char: string): string {
  return [...Buffer.from(char, 'utf8')]
    .map((byte) => {
      const c = String.fromCharCode(byte);
      return /[A-Za-z0-9]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/** Press a key on the device via ECP. Port 8060 needs no authentication. */
export async function keypress(ip: string, key: string): Promise<void> {
  // A Lit_ key carries its own encoding; a named key is a bare identifier.
  const path = key.startsWith('Lit_') ? key : encodeURIComponent(key);
  await request('POST', `http://${ip}:8060/keypress/${path}`);
}

/**
 * Type a literal string one character at a time.
 * ECP has no bulk-text endpoint, so each character is its own Lit_ keypress.
 */
export async function typeText(ip: string, text: string): Promise<void> {
  for (const char of [...text]) {
    await keypress(ip, `Lit_${encodeLiteral(char)}`);
  }
}

export async function launchChannel(ip: string, appId = 'dev'): Promise<void> {
  await request('POST', `http://${ip}:8060/launch/${encodeURIComponent(appId)}`);
}

function curl(args: string[], binary: boolean): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args);
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d as Buffer));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr }));
  });
}

function digestArgs(user: string, password: string, extra: string[]): string[] {
  return ['--silent', '--show-error', '--digest', '--user', `${user}:${password}`, '--max-time', '30', ...extra];
}

export interface Creds {
  ip: string;
  user: string;
  password: string;
}

/**
 * Ask the device to render a screenshot, then download it.
 * plugin_inspect generates the image; the file is then served from /pkgs/dev.jpg.
 */
export async function screenshot(creds: Creds): Promise<Buffer> {
  const { ip, user, password } = creds;

  const gen = await curl(digestArgs(user, password, [
    '--form', 'mysubmit=Screenshot',
    '--form', 'archive=',
    '--form', 'passwd=',
    `http://${ip}/plugin_inspect`
  ]), false);
  if (gen.code !== 0) {
    throw new Error(gen.stderr.trim() || `curl exit ${gen.code}`);
  }
  const body = gen.stdout.toString('utf8');
  if (/401 Unauthorized|Access denied/i.test(body)) {
    throw new Error('Device rejected the credentials.');
  }

  // The response names the generated file; fall back to the conventional path.
  const named = /pkgs\/(dev[^"'\s?]*\.(?:jpg|png))/i.exec(body);
  const candidates = named
    ? [`/pkgs/${named[1]}`]
    : ['/pkgs/dev.jpg', '/pkgs/dev.png'];

  for (const relativePath of candidates) {
    const img = await curl(digestArgs(user, password, ['--location', `http://${ip}${relativePath}`]), true);
    if (img.code === 0 && img.stdout.length > 1024 && !/^\s*<(?:!DOCTYPE|html)/i.test(img.stdout.subarray(0, 64).toString('utf8'))) {
      return img.stdout;
    }
  }
  throw new Error('Device generated no screenshot. Is a dev channel running?');
}

export interface RegistrySection {
  name: string;
  values: Record<string, string>;
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:tr|div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Read the dev channel's registry. The device returns it inside an HTML page as
 * a JSON-ish blob, so we pull the braced section out and parse what we can.
 */
export async function readRegistry(creds: Creds): Promise<{ sections: RegistrySection[]; raw: string; supported: boolean }> {
  const { ip, user, password } = creds;
  // The dev password must go in the form body here; digest auth alone returns a
  // "Please enter a password" page for this particular submit.
  const res = await curl(digestArgs(user, password, [
    '--form', 'mysubmit=Get registry',
    '--form', 'archive=',
    '--form', `passwd=${password}`,
    `http://${ip}/plugin_inspect`
  ]), false);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `curl exit ${res.code}`);
  }

  const text = stripTags(res.stdout.toString('utf8'));
  if (/401 Unauthorized|Access denied/i.test(text)) {
    throw new Error('Device rejected the credentials.');
  }

  const sections: RegistrySection[] = [];
  // Shape: devId: <id> ... sections: { "section": { "key": "value", ... }, ... }
  const blob = /\{[\s\S]*\}/.exec(text);
  if (blob) {
    try {
      const parsed = JSON.parse(blob[0].replace(/,\s*(\}|\])/g, '$1')) as Record<string, unknown>;
      const container = (parsed.sections ?? parsed) as Record<string, unknown>;
      for (const [name, values] of Object.entries(container)) {
        if (values && typeof values === 'object' && !Array.isArray(values)) {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
            flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
          }
          sections.push({ name, values: flat });
        }
      }
    } catch {
      // Leave sections empty; the raw text is still returned for inspection.
    }
  }

  const raw = text.replace(/\n{3,}/g, '\n\n').trim();
  // Some firmware builds accept the request but return an empty body for every
  // submit, including invalid ones. Report that rather than an empty registry.
  // Look for the real markers only. The page ships boilerplate JavaScript, so a
  // bare brace is not evidence that the device answered with registry data.
  const supported = sections.length > 0 || /\bdev(?:eloper)?\s*Id\b/i.test(raw) || /"sections"/i.test(raw);
  return { sections, raw, supported };
}

/** Wipe the dev channel's registry. Destructive: clears stored credentials and state. */
export async function deleteRegistry(creds: Creds): Promise<void> {
  const { ip, user, password } = creds;
  const res = await curl(digestArgs(user, password, [
    '--form', 'mysubmit=Delete registry',
    '--form', 'archive=',
    '--form', `passwd=${password}`,
    `http://${ip}/plugin_inspect`
  ]), false);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `curl exit ${res.code}`);
  }
}

export type ImageQuality = 'low' | 'normal' | 'high' | 'best';

export interface ResizeOptions {
  /** Longest-edge cap in pixels. 0 or less leaves the image untouched. */
  maxPx: number;
  quality: ImageQuality;
}

const QUALITY_VALUES: Record<ImageQuality, number> = {
  low: 40,
  normal: 60,
  high: 80,
  best: 92
};

/**
 * Downscale and recompress a JPEG entirely in JavaScript.
 *
 * Device frames arrive at 1920x1080 and 50-135 KB, which is wasteful for an
 * agent that only needs to see which screen is showing. Capping the longest
 * edge at 500px costs a few KB and stays legible.
 *
 * jpeg-js is used rather than a native library or a shell-out so the same code
 * runs on macOS, Linux and Windows. Returns the original bytes unchanged if
 * resizing is off, decoding fails, or the result would not be smaller.
 */
export async function resizeJpeg(image: Buffer, opts: ResizeOptions): Promise<Buffer> {
  if (!opts.maxPx || opts.maxPx <= 0) { return image; }

  try {
    const jpeg = await import('jpeg-js');
    const decoded = jpeg.decode(image, { useTArray: true });
    const { width, height, data } = decoded;

    const scale = opts.maxPx / Math.max(width, height);
    if (scale >= 1) {
      // Already within the cap; only recompress if that actually helps.
      const same = jpeg.encode({ data, width, height }, QUALITY_VALUES[opts.quality]).data;
      return same.length < image.length ? Buffer.from(same) : image;
    }

    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const out = Buffer.alloc(outW * outH * 4);

    // Box filter: average the source pixels each output pixel covers, so
    // downscaled text stays readable instead of aliasing away.
    const xRatio = width / outW;
    const yRatio = height / outH;
    for (let y = 0; y < outH; y++) {
      const sy0 = Math.floor(y * yRatio);
      const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
      for (let x = 0; x < outW; x++) {
        const sx0 = Math.floor(x * xRatio);
        const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let idx = (sy * width + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++, idx += 4) {
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            n++;
          }
        }
        const o = (y * outW + x) * 4;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = 255;
      }
    }

    const encoded = jpeg.encode({ data: out, width: outW, height: outH }, QUALITY_VALUES[opts.quality]).data;
    const result = Buffer.from(encoded);
    return result.length > 0 && result.length < image.length ? result : image;
  } catch {
    // A frame we cannot decode is still a usable frame.
    return image;
  }
}
