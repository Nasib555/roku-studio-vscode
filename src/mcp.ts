#!/usr/bin/env node
/**
 * MCP server exposing the Roku workflow to AI agents.
 *
 * Deliberately standalone: it talks to the device over HTTP and does not need
 * VS Code running. Speaks JSON-RPC 2.0 over stdio, framed by newlines, so it
 * carries no dependencies beyond Node itself.
 *
 *   Register it with any MCP client: node <path>/out/mcp.js
 *
 * Device and credentials come from the environment:
 *   ROKU_IP, ROKU_USER (default rokudev), ROKU_PASS, ROKU_APP_DIR
 * Any tool argument overrides them for that call.
 */
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import { deploy } from './deploy';
import * as ecp from './ecp';
import { describe, scan } from './discovery';

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER = { name: 'roku-studio', version: '0.3.0' };

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

/** Resolve device + credentials from arguments, falling back to the environment. */
function resolveCreds(args: Record<string, unknown>): ecp.Creds {
  const ip = String(args.ip ?? env('ROKU_IP'));
  if (!ip) {
    throw new Error('No device IP. Pass "ip", or set ROKU_IP in the server environment.');
  }
  return {
    ip,
    user: String(args.user ?? env('ROKU_USER', 'rokudev')),
    password: String(args.password ?? env('ROKU_PASS'))
  };
}

function resolveAppDir(args: Record<string, unknown>): string {
  const dir = String(args.appDir ?? env('ROKU_APP_DIR') ?? '');
  if (!dir) {
    throw new Error('No app directory. Pass "appDir", or set ROKU_APP_DIR.');
  }
  return path.resolve(dir);
}

/** Collect debug-console output for a bounded window, then return it. */
function tailConsole(ip: string, ms: number, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port: 8085 });
    let buffer = '';
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) { reject(err); } else { resolve(buffer); }
    };

    const timer = setTimeout(() => finish(), ms);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // Keep the newest output when the channel is chatty.
      if (buffer.length > maxBytes) { buffer = buffer.slice(-maxBytes); }
    });
    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish());
  });
}

const TOOLS = [
  {
    name: 'rokustudio_scan',
    description: 'Discover Roku devices on the local network via SSDP. Returns each device\'s IP, name, model, serial and whether developer mode is enabled.',
    inputSchema: {
      type: 'object',
      properties: { timeoutMs: { type: 'number', description: 'How long to listen for replies (default 4000).' } }
    }
  },
  {
    name: 'rokustudio_device_info',
    description: 'Query one Roku for its name, model, serial and developer-mode state. Use this to confirm a device is reachable before deploying.',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string', description: 'Device IP. Defaults to ROKU_IP.' } }
    }
  },
  {
    name: 'rokustudio_deploy',
    description: 'Sideload a channel: zips the app folder, uninstalls the previous dev build and installs the new one. Returns any BrightScript compile errors with their file and line. Requires the dev password.',
    inputSchema: {
      type: 'object',
      properties: {
        appDir: { type: 'string', description: 'Folder containing the manifest. Defaults to ROKU_APP_DIR.' },
        ip: { type: 'string' },
        user: { type: 'string' },
        password: { type: 'string' },
        bumpManifest: { type: 'boolean', description: 'Append a blank line to the manifest so the package always differs (default true).' },
        bumpBuildVersion: { type: 'boolean', description: 'Also increment build_version (default false).' }
      }
    }
  },
  {
    name: 'rokustudio_screenshot',
    description: 'Capture the device screen as a JPEG image. The dev channel must be RUNNING or the device refuses. By default the image is downscaled to 500px on its longest edge and recompressed (about 16 KB instead of 135 KB), which stays readable for checking which screen is showing. Raise maxPx or quality when fine detail matters; pass maxPx 0 for the untouched 1920x1080 frame.',
    inputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string' }, user: { type: 'string' }, password: { type: 'string' },
        savePath: { type: 'string', description: 'Optional file path to also write the image to. The saved file is the FULL-RESOLUTION capture, not the downscaled one.' },
        maxPx: { type: 'number', description: 'Longest-edge cap in pixels for the returned image (default 500). 0 returns the original 1920x1080 frame.' },
        quality: { type: 'string', enum: ['low', 'normal', 'high', 'best'], description: 'JPEG quality for the returned image (default normal).' }
      }
    }
  },
  {
    name: 'rokustudio_keypress',
    description: 'Send remote-control keys to the device. Keys: Up, Down, Left, Right, Select, Back, Home, Play, Rev, Fwd, InstantReplay, Info, Backspace, Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys to press in order.' },
        key: { type: 'string', description: 'A single key, if only one is needed.' },
        ip: { type: 'string' },
        delayMs: { type: 'number', description: 'Pause between keys (default 120).' }
      }
    }
  },
  {
    name: 'rokustudio_type',
    description: 'Type literal text into the focused on-screen field, one character at a time. Use for URLs, logins and search boxes.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, ip: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'rokustudio_launch',
    description: 'Launch or relaunch a channel on the device. Defaults to the sideloaded dev channel.',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string' }, appId: { type: 'string', description: 'Channel id; default "dev".' } }
    }
  },
  {
    name: 'rokustudio_console',
    description: 'Collect BrightScript debug-console output (port 8085) for a fixed window and return it. Use after a deploy or a crash to read logs and stack traces.',
    inputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string' },
        durationMs: { type: 'number', description: 'How long to listen, 500-60000 (default 5000).' },
        maxBytes: { type: 'number', description: 'Cap on returned text (default 65536).' }
      }
    }
  },
  {
    name: 'rokustudio_registry',
    description: 'Read the dev channel\'s registry (stored settings and credentials). Note: some firmware does not expose this and returns nothing.',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string' }, user: { type: 'string' }, password: { type: 'string' } }
    }
  }
] as const;

function textResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'rokustudio_scan': {
      const devices = await scan(Number(args.timeoutMs ?? 4000));
      if (!devices.length) {
        return textResult('No Roku devices answered. SSDP multicast may be blocked on this network; use rokustudio_device_info with a known IP instead.');
      }
      return textResult(JSON.stringify(devices, null, 2));
    }

    case 'rokustudio_device_info': {
      const ip = String(args.ip ?? env('ROKU_IP'));
      if (!ip) { throw new Error('No device IP. Pass "ip", or set ROKU_IP.'); }
      const device = await describe(ip);
      if (!device) { return textResult(`No Roku responded at ${ip}.`); }
      if (!device.devMode) {
        return textResult(`${JSON.stringify(device, null, 2)}\n\nWarning: developer mode is OFF, so sideloading will fail.`);
      }
      return textResult(JSON.stringify(device, null, 2));
    }

    case 'rokustudio_deploy': {
      const creds = resolveCreds(args);
      if (!creds.password) { throw new Error('No dev password. Pass "password", or set ROKU_PASS.'); }
      const lines: string[] = [];
      try {
        const result = await deploy({
          appDir: resolveAppDir(args),
          ip: creds.ip,
          user: creds.user,
          password: creds.password,
          bumpManifest: args.bumpManifest !== false,
          bumpBuildVersion: args.bumpBuildVersion === true,
          log: (l) => lines.push(l)
        });
        const problems = result.problems.length
          ? '\n\nCompile problems:\n' + result.problems.map((p) => `  ${p.pkgPath}:${p.line}  ${p.message}`).join('\n')
          : '';
        return textResult(`${lines.join('\n')}${problems}`);
      } catch (err) {
        const problems = (err as { problems?: { pkgPath: string; line: number; message: string }[] }).problems ?? [];
        const detail = problems.length
          ? '\n\nCompile errors:\n' + problems.map((p) => `  ${p.pkgPath}:${p.line}  ${p.message}`).join('\n')
          : '';
        throw new Error(`${lines.join('\n')}\n\nFAILED: ${(err as Error).message}${detail}`);
      }
    }

    case 'rokustudio_screenshot': {
      const creds = resolveCreds(args);
      if (!creds.password) { throw new Error('No dev password. Pass "password", or set ROKU_PASS.'); }
      const image = await ecp.screenshot(creds);
      const content: Record<string, unknown>[] = [];

      // Save the full-resolution capture: a file is kept for later inspection,
      // while the returned image is shrunk only to keep the response small.
      if (args.savePath) {
        const file = path.resolve(String(args.savePath));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, image);
        content.push({ type: 'text', text: `Saved ${image.length} bytes (full resolution) to ${file}` });
      }

      const maxPx = args.maxPx === undefined ? 500 : Number(args.maxPx);
      const quality = (args.quality ? String(args.quality) : 'normal') as ecp.ImageQuality;
      const sent = await ecp.resizeJpeg(image, { maxPx, quality });
      if (sent.length < image.length) {
        content.push({
          type: 'text',
          text: `Image downscaled to ${maxPx}px on the longest edge at ${quality} quality (${Math.round(image.length / 1024)} KB -> ${Math.round(sent.length / 1024)} KB). Pass maxPx: 0 for the full 1920x1080 frame.`
        });
      }
      content.push({ type: 'image', data: sent.toString('base64'), mimeType: 'image/jpeg' });
      return { content };
    }

    case 'rokustudio_keypress': {
      const ip = String(args.ip ?? env('ROKU_IP'));
      if (!ip) { throw new Error('No device IP. Pass "ip", or set ROKU_IP.'); }
      const keys = Array.isArray(args.keys)
        ? (args.keys as unknown[]).map(String)
        : (args.key ? [String(args.key)] : []);
      if (!keys.length) { throw new Error('Pass "key" or a non-empty "keys" array.'); }
      const delay = Number(args.delayMs ?? 120);
      for (const key of keys) {
        await ecp.keypress(ip, key);
        if (delay > 0 && keys.length > 1) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      return textResult(`Sent: ${keys.join(', ')}`);
    }

    case 'rokustudio_type': {
      const ip = String(args.ip ?? env('ROKU_IP'));
      if (!ip) { throw new Error('No device IP. Pass "ip", or set ROKU_IP.'); }
      const text = String(args.text ?? '');
      await ecp.typeText(ip, text);
      return textResult(`Typed ${[...text].length} characters.`);
    }

    case 'rokustudio_launch': {
      const ip = String(args.ip ?? env('ROKU_IP'));
      if (!ip) { throw new Error('No device IP. Pass "ip", or set ROKU_IP.'); }
      const appId = String(args.appId ?? 'dev');
      await ecp.launchChannel(ip, appId);
      return textResult(`Launched channel "${appId}".`);
    }

    case 'rokustudio_console': {
      const ip = String(args.ip ?? env('ROKU_IP'));
      if (!ip) { throw new Error('No device IP. Pass "ip", or set ROKU_IP.'); }
      const ms = Math.min(60000, Math.max(500, Number(args.durationMs ?? 5000)));
      const out = await tailConsole(ip, ms, Number(args.maxBytes ?? 65536));
      const trimmed = out.trim();
      // The device accepts only one connection on 8085 at a time.
      if (/already in use/i.test(trimmed)) {
        return textResult('The debug console is already in use by another client (the VS Code extension, a telnet session, or another agent). Disconnect it and retry.');
      }
      return textResult(trimmed || `(no console output in ${ms} ms; the channel may be idle or not running)`);
    }

    case 'rokustudio_registry': {
      const creds = resolveCreds(args);
      if (!creds.password) { throw new Error('No dev password. Pass "password", or set ROKU_PASS.'); }
      const { sections, supported } = await ecp.readRegistry(creds);
      if (!supported) {
        return textResult('This device\'s firmware does not expose the registry over plugin_inspect; it returns an empty response for every request.');
      }
      return textResult(JSON.stringify(sections, null, 2));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req: Rpc): Promise<void> {
  const { id, method, params } = req;
  // Notifications carry no id and take no reply.
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: SERVER
          }
        });
        return;
      case 'notifications/initialized':
        return;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const name = String((params as { name?: string })?.name ?? '');
        const args = ((params as { arguments?: Record<string, unknown> })?.arguments ?? {});
        const result = await callTool(name, args);
        send({ jsonrpc: '2.0', id, result });
        return;
      }
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      default:
        if (isRequest) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isRequest) {
      // Report tool failures as results so the agent can read and act on them.
      if (method === 'tools/call') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
      }
    }
  }
}

function main(): void {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) { continue; }
      try {
        void handle(JSON.parse(line) as Rpc);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
