import * as net from 'net';
import * as vscode from 'vscode';
import { CrashScanner, ParsedLocation } from './parse';

const DEBUG_PORT = 8085;

/**
 * Streams a Roku's port-8085 debug output into an Output channel.
 * Roku serves plain text there, so no telnet option negotiation is needed.
 */
export class DebugConsole implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private socket?: net.Socket;
  private ip?: string;
  private closing = false;
  private retry?: NodeJS.Timeout;
  private readonly onStateChange: () => void;
  private readonly onCrash: (problems: ParsedLocation[]) => void;
  private readonly scanner = new CrashScanner();

  constructor(onStateChange: () => void, onCrash: (problems: ParsedLocation[]) => void) {
    this.channel = vscode.window.createOutputChannel('Roku Debug');
    this.onStateChange = onStateChange;
    this.onCrash = onCrash;
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  get target(): string | undefined {
    return this.ip;
  }

  show(): void {
    this.channel.show(true);
  }

  log(line: string): void {
    this.channel.appendLine(line);
  }

  connect(ip: string, reveal = true): void {
    if (this.connected && this.ip === ip) {
      if (reveal) { this.show(); }
      return;
    }
    this.disconnect();
    this.closing = false;
    this.ip = ip;
    this.scanner.reset();

    if (reveal) { this.show(); }
    this.channel.appendLine(`--- connecting to ${ip}:${DEBUG_PORT} ---`);

    const socket = net.createConnection({ host: ip, port: DEBUG_PORT });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 10_000);

    socket.on('connect', () => {
      this.channel.appendLine(`--- connected to ${ip}:${DEBUG_PORT} ---`);
      this.onStateChange();
    });

    // Roku emits partial lines; append raw and let the channel handle wrapping.
    socket.on('data', (chunk: string) => {
      this.channel.append(chunk);
      // Runtime crashes name a pkg:/ file and line; surface those in Problems.
      const problems = this.scanner.push(chunk);
      if (problems.length) { this.onCrash(problems); }
    });

    socket.on('error', (err) => {
      this.channel.appendLine(`--- console error: ${err.message} ---`);
    });

    socket.on('close', () => {
      if (this.socket === socket) { this.socket = undefined; }
      this.onStateChange();
      if (this.closing) {
        this.channel.appendLine('--- disconnected ---');
        return;
      }
      // The device drops 8085 whenever the channel restarts; come back on our own.
      this.channel.appendLine('--- connection closed, retrying in 2s ---');
      this.retry = setTimeout(() => {
        if (!this.closing && this.ip) { this.connect(this.ip, false); }
      }, 2000);
    });
  }

  /** Drop and immediately re-establish the stream, e.g. after a sideload. */
  reconnect(delayMs = 1500): void {
    const ip = this.ip;
    if (!ip) { return; }
    this.disconnect();
    setTimeout(() => this.connect(ip, false), delayMs);
  }

  disconnect(): void {
    this.closing = true;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    if (this.socket) {
      this.socket.removeAllListeners('close');
      this.socket.destroy();
      this.socket = undefined;
    }
    this.onStateChange();
  }

  dispose(): void {
    this.disconnect();
    this.channel.dispose();
  }
}
