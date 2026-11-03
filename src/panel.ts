import * as vscode from 'vscode';
import { RokuDevice } from './discovery';

export interface PanelState {
  /** When false the extension holds no sockets, timers or watchers. */
  enabled: boolean;
  devices: RokuDevice[];
  selectedIp?: string;
  /** Extra devices targeted alongside the selected one. */
  alsoDeployTo: string[];
  manualIp: string;
  user: string;
  hasPassword: boolean;
  scanning: boolean;
  deploying: boolean;
  consoleConnected: boolean;
  watching: boolean;
  appDir: string;
  historyCount: number;
  status: string;
}

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'scan' }
  | { type: 'select'; ip: string }
  | { type: 'toggleTarget'; ip: string }
  | { type: 'deploy' }
  | { type: 'saveCreds'; user: string; password: string }
  | { type: 'manualIp'; ip: string }
  | { type: 'toggleConsole' }
  | { type: 'toggleWatch' }
  | { type: 'openWebUI' }
  | { type: 'pickAppDir' }
  | { type: 'forgetCreds' }
  | { type: 'screenshot' }
  | { type: 'registry' }
  | { type: 'history' }
  | { type: 'key'; key: string }
  | { type: 'typeText'; text: string }
  | { type: 'relaunch' }
  | { type: 'liveView' }
  | { type: 'clearShots' }
  | { type: 'setEnabled'; on: boolean }
  | { type: 'padKey'; key: string }
  | { type: 'padText'; text: string };

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class RokuPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'rokuStudio.panel';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => PanelState,
    private readonly onMessage: (msg: PanelMessage) => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
  }

  refresh(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.getState() });
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  private html(): string {
    const n = nonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    /* A webview defaults to the editor background, which is darker than the
       sidebar it sits in. Match the sidebar so the panel blends with Explorer. */
    background: var(--vscode-sideBar-background, transparent);
    padding: 10px 12px 24px;
    margin: 0;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .07em;
    opacity: .7;
    margin: 18px 0 7px;
    font-weight: 600;
  }
  h3:first-of-type { margin-top: 2px; }
  button {
    font-family: inherit;
    font-size: 12px;
    border: none;
    border-radius: 3px;
    padding: 6px 10px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
    color: var(--vscode-button-secondaryForeground, inherit);
  }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.32)); }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    width: 100%;
    padding: 9px;
    font-weight: 600;
  }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.active {
    background: var(--vscode-inputOption-activeBackground, var(--vscode-button-background));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-button-foreground));
    outline: 1px solid var(--vscode-focusBorder);
  }
  button:disabled { opacity: .45; cursor: default; }
  input {
    width: 100%;
    font-family: inherit;
    font-size: 12px;
    padding: 5px 7px;
    border-radius: 3px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  label { display: block; font-size: 11px; opacity: .75; margin: 8px 0 3px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row > button { flex: none; }
  .row > input { flex: 1; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    padding: 7px 9px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
    margin-bottom: 3px;
  }
  li:hover { background: var(--vscode-list-hoverBackground); }
  li.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-color: var(--vscode-focusBorder);
  }
  li .body { flex: 1; min-width: 0; }
  .tick {
    flex: none;
    width: 14px; height: 14px;
    margin-top: 1px;
    border-radius: 3px;
    border: 1px solid var(--vscode-checkbox-border, rgba(128,128,128,.6));
    background: var(--vscode-checkbox-background, transparent);
    font-size: 10px;
    line-height: 12px;
    text-align: center;
    cursor: pointer;
    user-select: none;
  }
  .tick.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .tick.locked { opacity: .5; cursor: default; }
  .name { font-weight: 600; font-size: 12px; }
  .meta { font-size: 11px; opacity: .72; margin-top: 2px; }
  .warn { color: var(--vscode-editorWarning-foreground, #cc8500); }
  .empty { font-size: 11px; opacity: .6; padding: 8px 2px; line-height: 1.5; }
  .status {
    margin-top: 12px;
    font-size: 11px;
    opacity: .8;
    min-height: 15px;
    line-height: 1.45;
    word-break: break-word;
  }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
  .on { background: var(--vscode-testing-iconPassed, #3fb950); }
  .off { background: rgba(128,128,128,.55); }
  .hint { font-size: 10.5px; opacity: .55; margin-top: 5px; line-height: 1.45; }
  hr { border: none; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.22)); margin: 16px 0 0; }

  /* Master switch: the first thing in the panel, so its state is never a surprise. */
  .master {
    display: flex; align-items: center; gap: 9px;
    padding: 8px 10px; margin-bottom: 4px;
    border-radius: 5px;
    background: rgba(127, 127, 127, 0.11);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.2));
  }
  .switch {
    flex: none; width: 34px; height: 19px; border-radius: 19px;
    background: rgba(128,128,128,.45); position: relative; cursor: pointer;
    transition: background .14s ease; border: none; padding: 0;
  }
  .switch::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 15px; height: 15px; border-radius: 50%;
    background: #fff; transition: transform .14s ease;
  }
  .switch.on { background: var(--vscode-button-background); }
  .switch.on::after { transform: translateX(15px); }
  .master .label { font-size: 12px; font-weight: 600; }
  .master .sub { font-size: 10.5px; opacity: .62; margin-top: 1px; }
  body.off .dimmed { opacity: .4; pointer-events: none; }

  /* Keyboard capture pad: click to grab keystrokes, click away to release. */
  .pad {
    margin-top: 7px;
    padding: 12px 10px;
    border-radius: 5px;
    border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,.4));
    background: rgba(127, 127, 127, 0.08);
    text-align: center;
    cursor: text;
    outline: none;
    user-select: none;
    transition: border-color .12s ease, background .12s ease;
  }
  .pad:hover { border-color: var(--vscode-focusBorder); }
  .pad.live {
    border-style: solid;
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-inputOption-activeBackground, rgba(0,122,204,.14));
    cursor: none;
  }
  .pad .pstate { font-size: 11.5px; font-weight: 600; }
  .pad.live .pstate { color: var(--vscode-charts-green, #3fb950); }
  .pad .phint { font-size: 10.5px; opacity: .62; margin-top: 3px; line-height: 1.45; }
  .pad .plog {
    display: flex; flex-wrap: wrap; gap: 3px;
    justify-content: center; align-items: center;
    margin-top: 7px; min-height: 18px;
    max-height: 56px; overflow-y: auto;
  }
  .pad .plog:empty { min-height: 0; margin-top: 0; }
  .chip {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px; line-height: 1;
    padding: 3px 5px; border-radius: 3px;
    background: rgba(128,128,128,.26);
    white-space: pre;
    animation: pop .14s ease;
  }
  .chip.nav { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .chip.txt { background: rgba(128,128,128,.2); }
  .chip.recent { outline: 1px solid var(--vscode-focusBorder); }
  @keyframes pop { from { transform: scale(.82); opacity: .4; } to { transform: scale(1); opacity: 1; } }
  .pclear {
    font-size: 10px; opacity: .55; margin-top: 5px;
    cursor: pointer; text-decoration: underline;
  }
  .pclear:hover { opacity: .85; }
  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px;
           background: var(--vscode-charts-green, #3fb950); }

  /* Remote: a D-pad cluster plus transport row, sized for a narrow sidebar. */
  .dpad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 5px;
    max-width: 190px;
    margin: 0 auto;
  }
  .dpad button { padding: 9px 0; font-size: 13px; }
  .dpad .ok { font-size: 10px; font-weight: 700; letter-spacing: .04em; }
  .dpad .spacer { visibility: hidden; }
  .transport {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
    max-width: 190px;
    margin: 6px auto 0;
  }
  .transport button { padding: 7px 0; font-size: 11px; }
  .navrow {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 5px;
    max-width: 190px;
    margin: 6px auto 0;
  }
  .navrow button { padding: 7px 0; font-size: 11px; }
</style>
</head>
<body>
  <div class="master">
    <button class="switch" id="master" title="Turn the extension on or off" aria-label="Extension on/off"></button>
    <div>
      <div class="label" id="masterLabel">Roku Studio</div>
      <div class="sub" id="masterSub"></div>
    </div>
  </div>

  <div class="dimmed" id="main">
  <h3>Devices</h3>
  <div class="row">
    <button id="scan">Scan network</button>
    <button id="webui">Web UI</button>
  </div>
  <ul id="devices"></ul>
  <div id="noDevices" class="empty"></div>
  <div class="hint" id="targetHint"></div>

  <label for="manual">Device IP</label>
  <input id="manual" placeholder="192.168.1.50" spellcheck="false">
  <div class="hint">Scanning uses SSDP multicast. On a VPN or guest network it may find nothing, so type the IP here instead.</div>

  <h3>Credentials</h3>
  <label for="user">Username</label>
  <input id="user" placeholder="rokudev" spellcheck="false">
  <label for="pass">Dev password</label>
  <input id="pass" type="password" placeholder="••••">
  <div class="row" style="margin-top:8px">
    <button id="save">Save</button>
    <button id="forget">Forget</button>
  </div>
  <div class="hint" id="credHint"></div>

  <h3>App folder</h3>
  <div class="row">
    <input id="appDir" readonly>
    <button id="pick">Browse</button>
  </div>

  <hr>
  <h3>Deploy</h3>
  <button class="primary" id="deploy">Deploy to Roku</button>
  <div class="grid2" style="margin-top:7px">
    <button id="console"></button>
    <button id="watch"></button>
  </div>
  <div class="grid2" style="margin-top:6px">
    <button id="screenshot">Screenshot</button>
    <button id="registry">Registry</button>
  </div>
  <div class="grid2" style="margin-top:6px">
    <button id="history">History…</button>
    <button id="relaunch">Relaunch</button>
  </div>
  <div class="grid2" style="margin-top:6px">
    <button id="live">Live preview</button>
    <button id="clearShots">Clear shots</button>
  </div>
  <div class="status" id="status"></div>

  <hr>
  <h3>Remote</h3>
  <div class="dpad">
    <span class="spacer"></span>
    <button data-key="Up" title="Up">▲</button>
    <span class="spacer"></span>
    <button data-key="Left" title="Left">◀</button>
    <button data-key="Select" class="ok" title="Select">OK</button>
    <button data-key="Right" title="Right">▶</button>
    <span class="spacer"></span>
    <button data-key="Down" title="Down">▼</button>
    <span class="spacer"></span>
  </div>
  <div class="navrow">
    <button data-key="Back" title="Back">Back</button>
    <button data-key="Home" title="Home">Home</button>
    <button data-key="Info" title="Options / *">Info</button>
  </div>
  <div class="transport">
    <button data-key="Rev" title="Rewind">◀◀</button>
    <button data-key="Play" title="Play / Pause">▶❙❙</button>
    <button data-key="Fwd" title="Fast forward">▶▶</button>
    <button data-key="InstantReplay" title="Instant replay">↺</button>
  </div>
  <label for="text">Send text to device</label>
  <div class="row">
    <input id="text" placeholder="type, then Enter" spellcheck="false">
    <button id="send">Send</button>
  </div>
  <div class="hint">Sent one character at a time to the focused on-screen field. Backspace and Enter have their own keys below.</div>
  <div class="grid2" style="margin-top:6px">
    <button data-key="Backspace">Backspace</button>
    <button data-key="Enter">Enter</button>
  </div>

  <div class="pad" id="pad" tabindex="0" role="application" aria-label="Keyboard capture for Roku">
    <div class="pstate" id="padState">Click to capture keyboard</div>
    <div class="phint" id="padHint">Keystrokes then go straight to the TV.</div>
    <div class="plog" id="padLog"></div>
    <div class="pclear" id="padClear" style="display:none">clear</div>
  </div>
  </div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  let state = null;
  // Don't clobber what the user is mid-way through typing.
  const editing = new Set();
  for (const id of ['manual', 'user', 'pass', 'text']) {
    el(id).addEventListener('focus', () => editing.add(id));
    el(id).addEventListener('blur', () => editing.delete(id));
  }

  const post = (msg) => vscode.postMessage(msg);

  el('master').addEventListener('click', () => post({ type: 'setEnabled', on: !(state && state.enabled) }));
  el('scan').addEventListener('click', () => post({ type: 'scan' }));
  el('webui').addEventListener('click', () => post({ type: 'openWebUI' }));
  el('deploy').addEventListener('click', () => post({ type: 'deploy' }));
  el('console').addEventListener('click', () => post({ type: 'toggleConsole' }));
  el('watch').addEventListener('click', () => post({ type: 'toggleWatch' }));
  el('screenshot').addEventListener('click', () => post({ type: 'screenshot' }));
  el('registry').addEventListener('click', () => post({ type: 'registry' }));
  el('history').addEventListener('click', () => post({ type: 'history' }));
  el('relaunch').addEventListener('click', () => post({ type: 'relaunch' }));
  el('live').addEventListener('click', () => post({ type: 'liveView' }));
  el('clearShots').addEventListener('click', () => post({ type: 'clearShots' }));
  el('pick').addEventListener('click', () => post({ type: 'pickAppDir' }));
  el('forget').addEventListener('click', () => post({ type: 'forgetCreds' }));
  el('save').addEventListener('click', () => {
    post({ type: 'saveCreds', user: el('user').value.trim() || 'rokudev', password: el('pass').value });
  });
  el('manual').addEventListener('change', () => post({ type: 'manualIp', ip: el('manual').value.trim() }));
  el('pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      post({ type: 'saveCreds', user: el('user').value.trim() || 'rokudev', password: el('pass').value });
    }
  });

  // Any button carrying data-key is a remote key.
  for (const btn of document.querySelectorAll('[data-key]')) {
    btn.addEventListener('click', () => post({ type: 'key', key: btn.dataset.key }));
  }

  const sendText = () => {
    const text = el('text').value;
    if (!text) { return; }
    post({ type: 'typeText', text });
    el('text').value = '';
  };
  el('send').addEventListener('click', sendText);
  el('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { sendText(); }
  });

  // --- keyboard capture pad -------------------------------------------------
  // While focused it swallows keystrokes and forwards them to the device, so
  // you can drive the TV without leaving the sidebar.
  const pad = el('pad');
  const NAV = {
    ArrowUp: '\u2191 Up', ArrowDown: '\u2193 Down', ArrowLeft: '\u2190 Left', ArrowRight: '\u2192 Right',
    Enter: 'OK', Escape: 'Back', Backspace: 'Backspace', Home: 'Home',
    F1: 'Home', F2: 'Back', F3: 'Rewind', F4: 'Play/Pause', F5: 'Forward',
    F6: 'Replay', F7: 'Info'
  };
  let padLive = false;
  const MAX_CHIPS = 24;

  /**
   * Append a key to the visible log. Consecutive printable characters merge
   * into one chip so typing a URL reads as text rather than a wall of chips.
   */
  function logKey(label, kind) {
    const log = el('padLog');
    const last = log.lastElementChild;
    if (kind === 'txt' && last && last.classList.contains('txt') && last.textContent.length < 18) {
      last.textContent += label;
    } else {
      const chip = document.createElement('span');
      chip.className = 'chip ' + kind;
      chip.textContent = label;
      log.append(chip);
      while (log.childElementCount > MAX_CHIPS) { log.firstElementChild.remove(); }
    }
    for (const c of log.querySelectorAll('.chip.recent')) { c.classList.remove('recent'); }
    log.lastElementChild.classList.add('recent');
    log.scrollTop = log.scrollHeight;
    el('padClear').style.display = log.childElementCount ? '' : 'none';
  }

  function clearLog() {
    el('padLog').innerHTML = '';
    el('padClear').style.display = 'none';
  }

  function padRender() {
    pad.className = 'pad' + (padLive ? ' live' : '');
    if (padLive) {
      el('padState').innerHTML = '<span class="pulse"></span>Capturing: keys go to the TV';
      el('padHint').textContent = 'Arrows move \u00b7 Enter OK \u00b7 Esc Back \u00b7 F4 Play \u00b7 Esc twice or click away to stop';
    } else {
      el('padState').textContent = 'Click to capture keyboard';
      el('padHint').textContent = 'Keystrokes then go straight to the TV.';
    }
  }

  pad.addEventListener('click', () => pad.focus());
  el('padClear').addEventListener('click', (e) => { e.stopPropagation(); clearLog(); });
  pad.addEventListener('focus', () => { padLive = true; padRender(); });
  pad.addEventListener('blur', () => { padLive = false; padRender(); });

  let lastEscape = 0;
  pad.addEventListener('keydown', (e) => {
    if (!padLive) { return; }
    // Let VS Code keep its own chords.
    if (e.metaKey || e.ctrlKey || e.altKey) { return; }

    const k = e.key;
    const isPrintable = [...k].length === 1;
    const isNav = Object.prototype.hasOwnProperty.call(NAV, k);
    if (!isPrintable && !isNav) { return; }

    // Double-Escape releases the pad instead of sending a second Back.
    if (k === 'Escape') {
      const now = Date.now();
      if (now - lastEscape < 600) {
        lastEscape = 0;
        pad.blur();
        e.preventDefault();
        return;
      }
      lastEscape = now;
    }

    e.preventDefault();
    e.stopPropagation();
    post({ type: 'padKey', key: k });
    // Show a space as a visible marker; a blank chip would look like a bug.
    logKey(isNav ? NAV[k] : (k === ' ' ? '\u2423' : k), isNav ? 'nav' : 'txt');
  });

  // Pasting beats typing a long URL one character at a time.
  pad.addEventListener('paste', (e) => {
    if (!padLive) { return; }
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) { return; }
    e.preventDefault();
    post({ type: 'padText', text });
    logKey('\u2398 ' + [...text].length + ' chars', 'nav');
  });

  padRender();

  function render() {
    if (!state) { return; }

    const enabled = state.enabled !== false;
    el('master').className = 'switch' + (enabled ? ' on' : '');
    el('masterLabel').textContent = enabled ? 'Roku Studio is on' : 'Roku Studio is off';
    el('masterSub').textContent = enabled
      ? 'Discovery, console and watch mode available.'
      : 'Idle. No sockets, timers or watchers running.';
    document.body.className = enabled ? '' : 'off';
    if (!enabled) {
      el('status').textContent = state.status || '';
      return;
    }
    const list = el('devices');
    list.innerHTML = '';
    for (const d of state.devices) {
      const li = document.createElement('li');
      if (d.ip === state.selectedIp) { li.className = 'selected'; }

      const isPrimary = d.ip === state.selectedIp;
      const alsoOn = state.alsoDeployTo.includes(d.ip);
      const tick = document.createElement('span');
      tick.className = 'tick' + (isPrimary || alsoOn ? ' on' : '') + (isPrimary ? ' locked' : '');
      tick.textContent = isPrimary || alsoOn ? '✓' : '';
      tick.title = isPrimary ? 'Primary target' : (alsoOn ? 'Also deploy here' : 'Include in deploy');
      if (!isPrimary) {
        tick.addEventListener('click', (e) => {
          e.stopPropagation();
          post({ type: 'toggleTarget', ip: d.ip });
        });
      }

      const body = document.createElement('div');
      body.className = 'body';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = d.name;
      const meta = document.createElement('div');
      meta.className = 'meta' + (d.devMode ? '' : ' warn');
      meta.textContent = d.ip + ' · ' + (d.model || 'Roku') + (d.devMode ? '' : ' · dev mode off');
      body.append(name, meta);

      li.append(tick, body);
      li.addEventListener('click', () => post({ type: 'select', ip: d.ip }));
      list.append(li);
    }

    const none = el('noDevices');
    if (state.scanning) {
      none.textContent = 'Scanning…';
    } else if (state.devices.length === 0) {
      none.textContent = 'No devices found yet. Press Scan network, or enter an IP below.';
    } else {
      none.textContent = '';
    }

    const extras = state.alsoDeployTo.length;
    el('targetHint').textContent = extras
      ? 'Deploying to ' + (extras + 1) + ' devices. Tick a checkbox to add or remove one.'
      : (state.devices.length > 1 ? 'Tick a checkbox to deploy to more than one device.' : '');

    if (!editing.has('manual')) { el('manual').value = state.manualIp || ''; }
    if (!editing.has('user')) { el('user').value = state.user || ''; }
    if (!editing.has('pass')) { el('pass').value = state.hasPassword ? '••••••••' : ''; }
    el('credHint').textContent = state.hasPassword
      ? 'Password stored in the OS keychain.'
      : 'No password saved yet.';

    el('appDir').value = state.appDir || '(no folder set)';
    el('scan').disabled = state.scanning;
    el('scan').textContent = state.scanning ? 'Scanning…' : 'Scan network';

    const noDevice = !state.selectedIp;
    el('deploy').disabled = state.deploying || noDevice;
    el('deploy').textContent = state.deploying
      ? 'Deploying…'
      : (extras ? 'Deploy to ' + (extras + 1) + ' devices' : 'Deploy to Roku');
    el('webui').disabled = noDevice;
    el('screenshot').disabled = noDevice;
    el('registry').disabled = noDevice;
    el('relaunch').disabled = noDevice;
    el('console').disabled = noDevice;
    el('live').disabled = noDevice;
    el('watch').disabled = noDevice;
    el('history').disabled = state.historyCount === 0;
    el('history').textContent = state.historyCount
      ? 'History (' + state.historyCount + ')…'
      : 'History…';

    for (const btn of document.querySelectorAll('[data-key]')) {
      btn.disabled = noDevice;
    }
    el('send').disabled = noDevice;
    el('text').disabled = noDevice;
    if (noDevice) {
      pad.removeAttribute('tabindex');
      if (padLive) { pad.blur(); }
      el('padState').textContent = 'Select a device to capture keys';
    } else if (!pad.hasAttribute('tabindex')) {
      pad.setAttribute('tabindex', '0');
      padRender();
    }

    el('console').innerHTML = '';
    const cdot = document.createElement('span');
    cdot.className = 'dot ' + (state.consoleConnected ? 'on' : 'off');
    el('console').append(cdot, document.createTextNode(state.consoleConnected ? 'Console on' : 'Console off'));

    el('watch').innerHTML = '';
    const wdot = document.createElement('span');
    wdot.className = 'dot ' + (state.watching ? 'on' : 'off');
    el('watch').className = state.watching ? 'active' : '';
    el('watch').append(wdot, document.createTextNode(state.watching ? 'Watch on' : 'Watch off'));

    el('status').textContent = state.status || '';
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data.state;
      render();
    }
  });

  post({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
