import * as vscode from 'vscode';
import * as ecp from './ecp';

/** Keys we forward from the webview to the device, by their DOM key name. */
const KEY_MAP: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Select',
  Escape: 'Back',
  Backspace: 'Backspace',
  Home: 'Home',
  // Space is NOT mapped here: it must reach the literal-text path so it types
  // a space. Transport controls live on the function keys below.
  F1: 'Home',
  F2: 'Back',
  F3: 'Rev',
  F4: 'Play',
  F5: 'Fwd',
  F6: 'InstantReplay',
  F7: 'Info'
};

export interface LiveViewDeps {
  creds: () => Promise<ecp.Creds | undefined>;
  onStatus: (text: string) => void;
  /** Persist a captured frame; returns a label for the status line. */
  saveFrame: (image: Buffer) => Promise<string>;
}

/**
 * A panel that repeatedly captures the device screen and forwards keystrokes.
 *
 * The device has no streaming API: each frame is a full plugin_inspect capture,
 * which measures around 1.2s on a Streaming Stick 4K. This is a refreshing
 * still, not video, and the UI says so rather than implying a live stream.
 */
export class LiveView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;
  private running = false;
  private busy = false;
  private intervalMs = 1500;
  private keyboardOn = true;
  private disposed = false;

  constructor(private readonly deps: LiveViewDeps) {}

  get active(): boolean {
    return !!this.panel;
  }

  async show(intervalMs: number): Promise<void> {
    this.intervalMs = intervalMs;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'rokuStudio.liveView',
      'Roku Live Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    this.panel = panel;
    panel.webview.html = this.html();

    panel.webview.onDidReceiveMessage((msg) => void this.handle(msg));
    panel.onDidDispose(() => {
      this.stop();
      this.panel = undefined;
    });

    this.start();
  }

  private async handle(msg: { type: string; key?: string; text?: string; value?: number; on?: boolean }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postConfig();
        break;
      case 'toggleRun':
        if (this.running) { this.stop(); } else { this.start(); }
        this.postConfig();
        break;
      case 'interval':
        if (typeof msg.value === 'number') {
          this.intervalMs = Math.max(500, msg.value);
          if (this.running) { this.start(); }
          this.postConfig();
        }
        break;
      case 'keyboard':
        this.keyboardOn = !!msg.on;
        this.postConfig();
        break;
      case 'key':
        if (msg.key) { await this.sendKey(msg.key); }
        break;
      case 'text':
        if (msg.text) { await this.sendText(msg.text); }
        break;
      case 'save':
        await this.saveCurrent();
        break;
      case 'refresh':
        await this.capture();
        break;
    }
  }

  /** Translate a DOM key event into an ECP key and send it. */
  private async sendKey(domKey: string): Promise<void> {
    const creds = await this.deps.creds();
    if (!creds) { return; }
    const mapped = KEY_MAP[domKey];
    try {
      if (mapped) {
        await ecp.keypress(creds.ip, mapped);
      } else if ([...domKey].length === 1) {
        // A single printable character goes as a literal keypress.
        await ecp.typeText(creds.ip, domKey);
      } else {
        return;
      }
      // Give the UI a moment to react before the next frame.
      setTimeout(() => void this.capture(), 250);
    } catch (err) {
      this.deps.onStatus(`Key failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sendText(text: string): Promise<void> {
    const creds = await this.deps.creds();
    if (!creds) { return; }
    try {
      await ecp.typeText(creds.ip, text);
      setTimeout(() => void this.capture(), 250);
    } catch (err) {
      this.deps.onStatus(`Send text failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private lastFrame?: Buffer;

  private async saveCurrent(): Promise<void> {
    if (!this.lastFrame) { return; }
    const label = await this.deps.saveFrame(this.lastFrame);
    this.post({ type: 'saved', label });
  }

  private start(): void {
    this.stop();
    this.running = true;
    void this.capture();
    this.timer = setInterval(() => void this.capture(), this.intervalMs);
    this.postConfig();
  }

  private stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async capture(): Promise<void> {
    // Captures take ~1.2s; overlapping them would queue requests indefinitely.
    if (this.busy || this.disposed || !this.panel) { return; }
    this.busy = true;
    try {
      const creds = await this.deps.creds();
      if (!creds) { this.stop(); return; }
      const started = Date.now();
      const image = await ecp.screenshot(creds);
      this.lastFrame = image;
      this.post({
        type: 'frame',
        data: image.toString('base64'),
        ms: Date.now() - started,
        bytes: image.length
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', message });
      // A stopped channel can't be captured; stop polling rather than spin.
      if (/no screenshot/i.test(message)) { this.stop(); this.postConfig(); }
    } finally {
      this.busy = false;
    }
  }

  private post(msg: unknown): void {
    void this.panel?.webview.postMessage(msg);
  }

  private postConfig(): void {
    this.post({
      type: 'config',
      running: this.running,
      intervalMs: this.intervalMs,
      keyboardOn: this.keyboardOn
    });
  }

  /** Close the panel and release the timer, while staying reusable. */
  close(): void {
    this.stop();
    this.panel?.dispose();
    this.panel = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.close();
  }

  private html(): string {
    const n = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.22));
    flex-wrap: wrap;
  }
  button {
    font-family: inherit; font-size: 12px; border: none; border-radius: 3px;
    padding: 5px 10px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
    color: var(--vscode-button-secondaryForeground, inherit);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.32)); }
  button.on {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  select {
    font-family: inherit; font-size: 12px; padding: 4px 6px; border-radius: 3px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
  }
  .stage {
    flex: 1; display: flex; align-items: center; justify-content: center;
    padding: 12px; min-height: 0; position: relative; outline: none;
  }
  .stage.focused::after {
    content: ''; position: absolute; inset: 6px; pointer-events: none;
    border: 2px solid var(--vscode-focusBorder); border-radius: 6px;
  }
  img {
    max-width: 100%; max-height: 100%; object-fit: contain;
    border-radius: 4px; background: #000;
    box-shadow: 0 2px 14px rgba(0,0,0,.35);
  }
  .placeholder { opacity: .6; font-size: 12px; text-align: center; line-height: 1.6; padding: 0 24px; }
  .foot {
    padding: 6px 12px; font-size: 11px; opacity: .75;
    border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.22));
    display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  }
  .err { color: var(--vscode-editorError-foreground, #f14c4c); }
  kbd {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
    padding: 1px 4px; border-radius: 3px;
    background: rgba(128,128,128,.22);
  }
</style>
</head>
<body>
  <div class="bar">
    <button id="run">Pause</button>
    <button id="refresh">Refresh</button>
    <select id="interval" title="How often to capture a new frame">
      <option value="1000">~1 s</option>
      <option value="1500" selected>1.5 s</option>
      <option value="2000">2 s</option>
      <option value="3000">3 s</option>
      <option value="5000">5 s</option>
    </select>
    <button id="kbd" class="on">Keyboard on</button>
    <button id="save">Save frame</button>
  </div>

  <div class="stage" id="stage" tabindex="0">
    <div class="placeholder" id="ph">Waiting for the first frame…<br>The dev channel must be running on the device.</div>
    <img id="shot" alt="Roku screen" style="display:none">
  </div>

  <div class="foot">
    <span id="info">&middot;</span>
    <span>Click the image, then type. <kbd>↑↓←→</kbd> navigate · <kbd>Enter</kbd> OK · <kbd>Esc</kbd> Back · <kbd>Space</kbd> types a space · <kbd>F4</kbd> Play · <kbd>F3</kbd>/<kbd>F5</kbd> Rew/Fwd</span>
  </div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  const post = (m) => vscode.postMessage(m);
  let keyboardOn = true;
  let frames = 0;

  el('run').addEventListener('click', () => post({ type: 'toggleRun' }));
  el('refresh').addEventListener('click', () => post({ type: 'refresh' }));
  el('save').addEventListener('click', () => post({ type: 'save' }));
  el('kbd').addEventListener('click', () => post({ type: 'keyboard', on: !keyboardOn }));
  el('interval').addEventListener('change', (e) => post({ type: 'interval', value: Number(e.target.value) }));

  const stage = el('stage');
  stage.addEventListener('focus', () => stage.classList.add('focused'));
  stage.addEventListener('blur', () => stage.classList.remove('focused'));
  stage.addEventListener('click', () => stage.focus());

  // Forward keystrokes only while the stage holds focus, so the toolbar and
  // VS Code's own shortcuts keep working.
  stage.addEventListener('keydown', (e) => {
    if (!keyboardOn) { return; }
    if (e.metaKey || e.ctrlKey || e.altKey) { return; }
    const k = e.key;
    const isPrintable = [...k].length === 1;
    const isNav = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape','Backspace','Home',
                   'F1','F2','F3','F4','F5','F6','F7'].includes(k);
    if (!isPrintable && !isNav) { return; }
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'key', key: k });
  });

  // Pasting a URL or password is far quicker than character-by-character typing.
  stage.addEventListener('paste', (e) => {
    if (!keyboardOn) { return; }
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) { e.preventDefault(); post({ type: 'text', text }); }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'frame') {
      frames++;
      el('shot').src = 'data:image/jpeg;base64,' + m.data;
      el('shot').style.display = '';
      el('ph').style.display = 'none';
      el('info').textContent = frames + ' frames · last ' + m.ms + ' ms · ' + Math.round(m.bytes / 1024) + ' KB';
      el('info').className = '';
    } else if (m.type === 'error') {
      el('info').textContent = m.message;
      el('info').className = 'err';
      el('ph').textContent = m.message;
    } else if (m.type === 'config') {
      keyboardOn = m.keyboardOn;
      el('run').textContent = m.running ? 'Pause' : 'Resume';
      el('run').className = m.running ? 'on' : '';
      el('kbd').textContent = m.keyboardOn ? 'Keyboard on' : 'Keyboard off';
      el('kbd').className = m.keyboardOn ? 'on' : '';
      el('interval').value = String(m.intervalMs);
    } else if (m.type === 'saved') {
      el('info').textContent = 'Saved ' + m.label;
      el('info').className = '';
    }
  });

  post({ type: 'ready' });
  stage.focus();
</script>
</body>
</html>`;
  }
}
