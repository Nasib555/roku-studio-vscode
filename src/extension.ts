import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugConsole } from './console';
import { deploy, DeployError, install } from './deploy';
import { ProblemReporter } from './diagnostics';
import { ParsedLocation } from './parse';
import { describe, RokuDevice, scan } from './discovery';
import * as ecp from './ecp';
import { describeEntry, DeployHistory, formatBytes, ScreenshotStore } from './history';
import { LiveView } from './liveview';
import { PanelMessage, PanelState, RokuPanel } from './panel';
import { DeployWatcher } from './watcher';

const SECRET_PASSWORD = 'rokuStudio.password';
const KEY_USER = 'rokuStudio.user';
const KEY_IP = 'rokuStudio.ip';
const KEY_DEVICES = 'rokuStudio.devices';
const KEY_TARGETS = 'rokuStudio.alsoDeployTo';
const KEY_ENABLED = 'rokuStudio.enabled';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new RokuExtension(context));
}

export function deactivate(): void { /* disposables handle teardown */ }

class RokuExtension implements vscode.Disposable {
  private readonly panel: RokuPanel;
  private readonly debugConsole: DebugConsole;
  private readonly problems: ProblemReporter;
  private readonly history: DeployHistory;
  private readonly shots: ScreenshotStore;
  private readonly liveView: LiveView;
  private readonly watcher: DeployWatcher;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private devices: RokuDevice[] = [];
  private selectedIp?: string;
  private alsoDeployTo: string[] = [];
  private user = 'rokudev';
  private hasPassword = false;
  private scanning = false;
  private deploying = false;
  private statusText = '';
  private enabled = true;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.devices = context.globalState.get<RokuDevice[]>(KEY_DEVICES, []);
    this.selectedIp = context.globalState.get<string>(KEY_IP);
    this.alsoDeployTo = context.globalState.get<string[]>(KEY_TARGETS, []);
    this.user = context.globalState.get<string>(KEY_USER, 'rokudev');
    this.enabled = context.globalState.get<boolean>(KEY_ENABLED, true);

    this.problems = new ProblemReporter();
    this.history = new DeployHistory(context, () => this.config().get<number>('historyLimit', 5));
    this.shots = new ScreenshotStore(context, () => this.config().get<number>('screenshotLimit', 50));
    this.liveView = new LiveView({
      creds: () => this.creds(),
      onStatus: (text) => this.setStatus(text),
      saveFrame: (image) => this.writeScreenshot(image)
    });
    this.debugConsole = new DebugConsole(
      () => this.refresh(),
      (found) => this.reportCrash(found)
    );
    this.watcher = new DeployWatcher(
      () => this.config().get<number>('watchDebounceMs', 1200),
      (reason) => this.onWatchTrigger(reason)
    );
    this.panel = new RokuPanel(
      context.extensionUri,
      () => this.state(),
      (msg) => void this.handle(msg)
    );

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'rokuStudio.quickPick';
    this.status.tooltip = 'Roku Studio: quick actions';

    this.disposables.push(
      this.debugConsole,
      this.problems,
      this.liveView,
      this.watcher,
      this.status,
      vscode.window.registerWebviewViewProvider(RokuPanel.viewId, this.panel, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      vscode.commands.registerCommand('rokuStudio.scan', () => this.scan()),
      vscode.commands.registerCommand('rokuStudio.deploy', () => this.deploy()),
      vscode.commands.registerCommand('rokuStudio.telnetConnect', () => this.connectConsole()),
      vscode.commands.registerCommand('rokuStudio.telnetDisconnect', () => this.debugConsole.disconnect()),
      vscode.commands.registerCommand('rokuStudio.openWebUI', () => this.openWebUI()),
      vscode.commands.registerCommand('rokuStudio.quickPick', () => this.quickPick()),
      vscode.commands.registerCommand('rokuStudio.screenshot', () => this.screenshot()),
      vscode.commands.registerCommand('rokuStudio.registry', () => this.showRegistry()),
      vscode.commands.registerCommand('rokuStudio.clearRegistry', () => this.clearRegistry()),
      vscode.commands.registerCommand('rokuStudio.history', () => this.showHistory()),
      vscode.commands.registerCommand('rokuStudio.toggleWatch', () => this.toggleWatch()),
      vscode.commands.registerCommand('rokuStudio.relaunch', () => this.relaunch()),
      vscode.commands.registerCommand('rokuStudio.remote', () => this.remoteQuickPick()),
      vscode.commands.registerCommand('rokuStudio.liveView', () => this.showLiveView()),
      vscode.commands.registerCommand('rokuStudio.clearScreenshots', () => this.clearScreenshots()),
      vscode.commands.registerCommand('rokuStudio.openScreenshotsFolder', () => this.openScreenshotsFolder()),
      vscode.commands.registerCommand('rokuStudio.toggleEnabled', () => this.setEnabled(!this.enabled))
    );

    void this.loadPassword();
    void this.history.prune().then(() => this.refresh());
    void this.autoDisableIfNotRoku();
    this.updateStatusBar();
    if (this.enabled) { this.status.show(); }
  }

  // ---- state ----------------------------------------------------------------

  private state(): PanelState {
    return {
      enabled: this.enabled,
      devices: this.devices,
      selectedIp: this.selectedIp,
      alsoDeployTo: this.alsoDeployTo,
      manualIp: this.selectedIp ?? '',
      user: this.user,
      hasPassword: this.hasPassword,
      scanning: this.scanning,
      deploying: this.deploying,
      consoleConnected: this.debugConsole.connected,
      watching: this.watcher.active,
      appDir: this.appDir() ?? '',
      historyCount: this.history.list().length,
      status: this.statusText
    };
  }

  private refresh(): void {
    this.panel.refresh();
    this.updateStatusBar();
  }

  private setStatus(text: string): void {
    this.statusText = text;
    this.refresh();
  }

  private updateStatusBar(): void {
    if (!this.enabled) {
      this.status.text = '$(circle-slash) Roku: off';
      return;
    }
    const device = this.devices.find((d) => d.ip === this.selectedIp);
    const label = device ? device.name : this.selectedIp ?? 'no device';
    const icon = this.deploying ? '$(sync~spin)' : (this.watcher.active ? '$(eye)' : '$(rocket)');
    const extra = this.alsoDeployTo.length ? ` +${this.alsoDeployTo.length}` : '';
    this.status.text = `${icon} Roku: ${label}${extra}`;
  }

  /**
   * Switch off by default in a workspace that holds no Roku manifest, so the
   * extension stays idle in unrelated projects. Only applies the first time a
   * workspace is seen: an explicit choice is never overridden.
   */
  private async autoDisableIfNotRoku(): Promise<void> {
    const seenKey = `rokuStudio.seen:${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''}`;
    if (this.context.globalState.get<boolean>(seenKey)) { return; }
    await this.context.globalState.update(seenKey, true);

    const dir = this.appDir();
    if (!dir) { return; }
    try {
      await fs.access(path.join(dir, 'manifest'));
      // A manifest is present: this is a Roku project, leave it on.
    } catch {
      this.enabled = false;
      await this.context.globalState.update(KEY_ENABLED, false);
      this.status.hide();
      this.refresh();
    }
  }

  private async loadPassword(): Promise<void> {
    const stored = await this.context.secrets.get(SECRET_PASSWORD);
    this.hasPassword = !!stored;
    this.refresh();
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('rokuStudio');
  }

  /** Absolute path to the folder holding the manifest, or undefined if unresolvable. */
  private appDir(): string | undefined {
    const configured = this.config().get<string>('appDir', 'root');
    if (path.isAbsolute(configured)) { return configured; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return undefined; }
    return path.join(folder.uri.fsPath, configured);
  }

  /** Resolve credentials, prompting for the password the first time. */
  private async creds(): Promise<ecp.Creds | undefined> {
    if (!this.selectedIp) {
      void vscode.window.showWarningMessage('Select a Roku device first.');
      this.panel.reveal();
      return undefined;
    }
    let password = await this.context.secrets.get(SECRET_PASSWORD);
    if (!password) {
      password = await vscode.window.showInputBox({
        prompt: `Developer password for ${this.selectedIp}`,
        password: true,
        ignoreFocusOut: true
      });
      if (password === undefined) { return undefined; }
      await this.context.secrets.store(SECRET_PASSWORD, password);
      this.hasPassword = true;
    }
    return { ip: this.selectedIp, user: this.user, password };
  }

  // ---- panel messages -------------------------------------------------------

  private async handle(msg: PanelMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': this.refresh(); break;
      case 'setEnabled': await this.setEnabled(msg.on); break;
      case 'padKey': await this.sendPadKey(msg.key); break;
      case 'padText': await this.sendText(msg.text); break;
      case 'scan': await this.scan(); break;
      case 'select': await this.select(msg.ip); break;
      case 'toggleTarget': await this.toggleTarget(msg.ip); break;
      case 'manualIp': await this.setManualIp(msg.ip); break;
      case 'saveCreds': await this.saveCreds(msg.user, msg.password); break;
      case 'forgetCreds':
        await this.context.secrets.delete(SECRET_PASSWORD);
        this.hasPassword = false;
        this.setStatus('Credentials forgotten.');
        break;
      case 'deploy': await this.deploy(); break;
      case 'toggleConsole':
        if (this.debugConsole.connected) { this.debugConsole.disconnect(); } else { this.connectConsole(); }
        break;
      case 'toggleWatch': this.toggleWatch(); break;
      case 'openWebUI': await this.openWebUI(); break;
      case 'pickAppDir': await this.pickAppDir(); break;
      case 'screenshot': await this.screenshot(); break;
      case 'registry': await this.showRegistry(); break;
      case 'history': await this.showHistory(); break;
      case 'relaunch': await this.relaunch(); break;
      case 'liveView': await this.showLiveView(); break;
      case 'clearShots': await this.clearScreenshots(); break;
      case 'key': await this.sendKey(msg.key); break;
      case 'typeText': await this.sendText(msg.text); break;
    }
  }

  /**
   * Turn the extension's active machinery on or off.
   * Off is not cosmetic: the debug socket closes, watch mode stops and the live
   * preview is disposed, so nothing polls the network on an unrelated project.
   */
  private async setEnabled(on: boolean): Promise<void> {
    if (this.enabled === on) { return; }
    this.enabled = on;
    await this.context.globalState.update(KEY_ENABLED, on);

    if (!on) {
      this.debugConsole.disconnect();
      this.watcher.stop();
      this.liveView.close();
      this.problems.clear();
      this.scanning = false;
      this.statusText = '';
      this.status.hide();
    } else {
      this.status.show();
      this.statusText = 'Roku Studio is on.';
    }
    this.refresh();
  }

  /** Guard for actions that need the extension switched on. */
  private requireEnabled(): boolean {
    if (this.enabled) { return true; }
    void vscode.window.showInformationMessage(
      'Roku Studio is switched off. Turn it on from the Roku panel to use this.',
      'Turn on'
    ).then((pick) => {
      if (pick) { void this.setEnabled(true); }
    });
    return false;
  }

  private async select(ip: string): Promise<void> {
    this.selectedIp = ip;
    // A device cannot be both the primary target and an extra one.
    if (this.alsoDeployTo.includes(ip)) {
      this.alsoDeployTo = this.alsoDeployTo.filter((x) => x !== ip);
      await this.context.globalState.update(KEY_TARGETS, this.alsoDeployTo);
    }
    await this.context.globalState.update(KEY_IP, ip);
    if (this.debugConsole.connected && this.debugConsole.target !== ip) {
      this.debugConsole.connect(ip, false);
    }
    this.refresh();
  }

  private async toggleTarget(ip: string): Promise<void> {
    if (ip === this.selectedIp) { return; }
    this.alsoDeployTo = this.alsoDeployTo.includes(ip)
      ? this.alsoDeployTo.filter((x) => x !== ip)
      : [...this.alsoDeployTo, ip];
    await this.context.globalState.update(KEY_TARGETS, this.alsoDeployTo);
    this.refresh();
  }

  private async setManualIp(ip: string): Promise<void> {
    if (!ip) { return; }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      this.setStatus(`"${ip}" is not a valid IPv4 address.`);
      return;
    }
    await this.select(ip);
    this.setStatus(`Checking ${ip}…`);
    const device = await describe(ip);
    if (device) {
      this.devices = [device, ...this.devices.filter((d) => d.ip !== ip)];
      await this.context.globalState.update(KEY_DEVICES, this.devices);
      this.setStatus(device.devMode ? `${device.name} ready.` : `${device.name} found, but developer mode is off.`);
    } else {
      // Keep the manual IP selected anyway: ECP can be off while sideloading still works.
      this.setStatus(`No Roku responded at ${ip}. Saved anyway; deploy will tell you for sure.`);
    }
    this.refresh();
  }

  private async saveCreds(user: string, password: string): Promise<void> {
    this.user = user;
    await this.context.globalState.update(KEY_USER, user);
    // The panel shows a bullet placeholder for an already-saved password; don't store that.
    if (password && !/^•+$/.test(password)) {
      await this.context.secrets.store(SECRET_PASSWORD, password);
      this.hasPassword = true;
      this.setStatus('Credentials saved to the OS keychain.');
    } else {
      this.setStatus('Username saved.');
    }
  }

  private async pickAppDir(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Use as app folder',
      title: 'Select the folder containing the Roku manifest'
    });
    if (!picked?.length) { return; }
    let target = picked[0].fsPath;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const rel = path.relative(folder.uri.fsPath, target);
      // Store a relative path when it stays inside the workspace, so the setting travels.
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { target = rel; }
    }
    await this.config().update('appDir', target, vscode.ConfigurationTarget.Workspace);
    const abs = this.appDir();
    if (abs) { this.watcher.retarget(abs); }
    this.setStatus(`App folder set to ${target}`);
  }

  // ---- discovery ------------------------------------------------------------

  private async scan(): Promise<void> {
    if (!this.requireEnabled()) { return; }
    if (this.scanning) { return; }
    this.scanning = true;
    this.setStatus('Scanning for Roku devices…');
    try {
      const found = await scan(this.config().get<number>('scanTimeoutMs', 4000));
      if (found.length) {
        // Preserve any manually added device the scan didn't see.
        const extras = this.devices.filter((d) => !found.some((f) => f.ip === d.ip));
        this.devices = [...found, ...extras];
        await this.context.globalState.update(KEY_DEVICES, this.devices);
        if (!this.selectedIp || !this.devices.some((d) => d.ip === this.selectedIp)) {
          await this.select(found[0].ip);
        }
        this.setStatus(`Found ${found.length} device${found.length === 1 ? '' : 's'}.`);
      } else {
        this.setStatus('No devices answered. Multicast may be blocked, so enter the IP manually.');
      }
    } catch (err) {
      this.setStatus(`Scan failed: ${describeError(err)}`);
    } finally {
      this.scanning = false;
      this.refresh();
    }
  }

  // ---- console + diagnostics ------------------------------------------------

  private connectConsole(): void {
    if (!this.requireEnabled()) { return; }
    if (!this.selectedIp) {
      void vscode.window.showWarningMessage('Select a Roku device first.');
      return;
    }
    this.debugConsole.connect(this.selectedIp);
  }

  private reportCrash(found: ParsedLocation[]): void {
    const appDir = this.appDir();
    if (!appDir) { return; }
    const placed = this.problems.add(appDir, found);
    if (placed > 0) {
      this.setStatus(`Runtime error reported in ${found[0].pkgPath}:${found[0].line}. See Problems.`);
    }
  }

  private async openWebUI(): Promise<void> {
    if (!this.selectedIp) {
      void vscode.window.showWarningMessage('Select a Roku device first.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(`http://${this.selectedIp}`));
  }

  // ---- deploy ---------------------------------------------------------------

  private async deploy(): Promise<void> {
    if (!this.requireEnabled()) { return; }
    if (this.deploying) { return; }

    const appDir = this.appDir();
    if (!appDir) {
      void vscode.window.showErrorMessage('Open a workspace folder, or set an absolute rokuStudio.appDir.');
      return;
    }
    const creds = await this.creds();
    if (!creds) { return; }

    const wasConnected = this.debugConsole.connected;
    this.deploying = true;
    this.problems.clear();
    this.setStatus('Deploying…');
    this.debugConsole.show();

    const extraTargets = this.alsoDeployTo.filter((ip) => ip !== creds.ip);

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Deploying to ${creds.ip}` },
        async (progress) => {
          const result = await deploy({
            appDir,
            ip: creds.ip,
            user: creds.user,
            password: creds.password,
            bumpManifest: this.config().get<boolean>('bumpManifest', true),
            bumpBuildVersion: this.config().get<boolean>('bumpBuildVersion', false),
            archiveTo: this.config().get<number>('historyLimit', 5) > 0 ? this.history.dir() : undefined,
            log: (line) => {
              this.debugConsole.log(line);
              progress.report({ message: line.replace(/^[•✓!]\s*/, '') });
            }
          });

          if (result.problems.length) {
            this.problems.setCompileProblems(appDir, result.problems);
          }

          if (result.archivedPath) {
            const { size } = await fs.stat(result.archivedPath);
            await this.history.record({
              file: result.archivedPath,
              timestamp: Date.now(),
              sizeBytes: size,
              buildVersion: result.buildVersion,
              deviceName: this.devices.find((d) => d.ip === creds.ip)?.name ?? creds.ip,
              ip: creds.ip
            });

            // Reuse the package already built for the remaining devices.
            for (const ip of extraTargets) {
              progress.report({ message: `installing on ${ip}` });
              this.debugConsole.log(`• also deploying to ${ip}`);
              try {
                await install(result.archivedPath, ip, creds.user, creds.password, (l) => this.debugConsole.log(l));
              } catch (err) {
                this.debugConsole.log(`✗ ${ip}: ${describeError(err)}`);
              }
            }
          } else if (extraTargets.length) {
            this.debugConsole.log('! multi-device deploy needs history enabled (rokuStudio.historyLimit > 0)');
          }
        }
      );

      const count = 1 + extraTargets.length;
      this.setStatus(count > 1 ? `Deployed to ${count} devices.` : 'Deployed.');

      if (this.config().get<boolean>('autoReconnectConsole', true)) {
        // The channel restarts on install, which kills port 8085; pick it back up.
        if (wasConnected) {
          this.debugConsole.reconnect();
        } else {
          this.debugConsole.connect(creds.ip, false);
        }
      }
    } catch (err) {
      const message = describeError(err);
      if (err instanceof DeployError && err.problems.length) {
        const placed = this.problems.setCompileProblems(appDir, err.problems);
        if (placed) {
          void vscode.commands.executeCommand('workbench.actions.view.problems');
        }
      }
      this.debugConsole.log(`✗ deploy failed: ${message}`);
      this.setStatus(`Deploy failed: ${message}`);
      void vscode.window.showErrorMessage(`Roku deploy failed: ${message}`);
    } finally {
      this.deploying = false;
      this.refresh();
    }
  }

  // ---- watch mode -----------------------------------------------------------

  private toggleWatch(): void {
    if (!this.requireEnabled()) { return; }
    if (this.watcher.active) {
      this.watcher.stop();
      this.setStatus('Watch mode off.');
      return;
    }
    const appDir = this.appDir();
    if (!appDir) {
      void vscode.window.showErrorMessage('Set an app folder before enabling watch mode.');
      return;
    }
    if (!this.selectedIp) {
      void vscode.window.showWarningMessage('Select a Roku device first.');
      return;
    }
    this.watcher.start(appDir);
    this.setStatus('Watch mode on. Saving a file redeploys.');
  }

  private onWatchTrigger(reason: string): void {
    if (this.deploying) { return; }
    this.debugConsole.log(`• watch: ${reason} changed, redeploying`);
    void this.deploy();
  }

  // ---- ECP features ---------------------------------------------------------

  /**
   * Handle a keystroke from the sidebar capture pad: named keys become remote
   * presses, anything printable is typed as literal text.
   */
  private async sendPadKey(domKey: string): Promise<void> {
    if (!this.enabled || !this.selectedIp) { return; }
    const mapped = PAD_KEY_MAP[domKey];
    try {
      if (mapped) {
        await ecp.keypress(this.selectedIp, mapped);
      } else if ([...domKey].length === 1) {
        await ecp.typeText(this.selectedIp, domKey);
      }
    } catch (err) {
      this.setStatus(`Key failed: ${describeError(err)}`);
    }
  }

  private async sendKey(key: string): Promise<void> {
    if (!this.enabled || !this.selectedIp) { return; }
    try {
      await ecp.keypress(this.selectedIp, key);
      this.setStatus(`Sent ${key}.`);
    } catch (err) {
      this.setStatus(`Remote failed: ${describeError(err)}`);
    }
  }

  private async sendText(text: string): Promise<void> {
    if (!this.enabled || !this.selectedIp) { return; }
    try {
      await ecp.typeText(this.selectedIp, text);
      this.setStatus(`Sent "${text}".`);
    } catch (err) {
      this.setStatus(`Send text failed: ${describeError(err)}`);
    }
  }

  private async relaunch(): Promise<void> {
    if (!this.requireEnabled()) { return; }
    if (!this.selectedIp) { return; }
    try {
      await ecp.launchChannel(this.selectedIp, 'dev');
      this.setStatus('Relaunched the dev channel.');
    } catch (err) {
      this.setStatus(`Relaunch failed: ${describeError(err)}`);
    }
  }

  /** Write a frame to the screenshots folder, pruning old ones if enabled. */
  private async writeScreenshot(image: Buffer): Promise<string> {
    const dir = this.shots.dir();
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `roku-${stamp}.jpg`);
    await fs.writeFile(file, image);
    if (this.config().get<boolean>('screenshotAutoPrune', true)) {
      const removed = await this.shots.prune();
      if (removed > 0) {
        this.debugConsole.log(`• pruned ${removed} old screenshot${removed === 1 ? '' : 's'}`);
      }
    }
    return path.basename(file);
  }

  private async screenshot(): Promise<void> {
    if (!this.requireEnabled()) { return; }
    const creds = await this.creds();
    if (!creds) { return; }
    this.setStatus('Capturing screenshot…');
    try {
      const image = await ecp.screenshot(creds);
      const name = await this.writeScreenshot(image);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(this.shots.dir(), name)));
      this.setStatus(`Screenshot saved: ${name}`);
    } catch (err) {
      this.setStatus(`Screenshot failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(`Screenshot failed: ${describeError(err)}`);
    }
  }

  private async showLiveView(): Promise<void> {
    if (!this.requireEnabled()) { return; }
    if (!this.selectedIp) {
      void vscode.window.showWarningMessage('Select a Roku device first.');
      this.panel.reveal();
      return;
    }
    await this.liveView.show(this.config().get<number>('liveViewIntervalMs', 1500));
    // Capture needs a running channel, so say that up front rather than failing.
    this.setStatus('Live preview open (~1 fps). The dev channel must be running.');
  }

  private async clearScreenshots(): Promise<void> {
    const files = await this.shots.list();
    if (!files.length) {
      void vscode.window.showInformationMessage('No saved screenshots.');
      return;
    }
    const total = formatBytes(files.reduce((s, f) => s + f.sizeBytes, 0));
    const choice = await vscode.window.showWarningMessage(
      `Delete ${files.length} saved screenshot${files.length === 1 ? '' : 's'} (${total})?`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') { return; }
    const removed = await this.shots.clear();
    this.setStatus(`Deleted ${removed} screenshot${removed === 1 ? '' : 's'} (${total}).`);
  }

  private async openScreenshotsFolder(): Promise<void> {
    const dir = this.shots.dir();
    await fs.mkdir(dir, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(dir));
  }

  private async showRegistry(): Promise<void> {
    const creds = await this.creds();
    if (!creds) { return; }
    this.setStatus('Reading registry…');
    try {
      const { sections, raw, supported } = await ecp.readRegistry(creds);
      if (!supported) {
        // This firmware answers every plugin_inspect submit with an empty body.
        this.setStatus('This device\u2019s firmware does not expose the registry over the web endpoint.');
        void vscode.window.showWarningMessage(
          'The device returned no registry data. This Roku\u2019s firmware does not support reading the registry over plugin_inspect.',
          'Open device web UI'
        ).then((pick) => {
          if (pick) { void this.openWebUI(); }
        });
        return;
      }
      const lines: string[] = [`# Roku registry: ${creds.ip}`, ''];
      if (sections.length) {
        for (const section of sections) {
          lines.push(`## ${section.name}`);
          const keys = Object.keys(section.values);
          if (!keys.length) {
            lines.push('(empty)');
          }
          for (const key of keys) {
            lines.push(`${key} = ${section.values[key]}`);
          }
          lines.push('');
        }
      } else {
        lines.push('(could not parse sections; raw device output below)', '');
      }
      lines.push('---', '', raw);

      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
        language: 'markdown'
      });
      await vscode.window.showTextDocument(doc, { preview: true });
      this.setStatus(sections.length
        ? `Registry: ${sections.length} section${sections.length === 1 ? '' : 's'}.`
        : 'Registry read, but sections could not be parsed.');
    } catch (err) {
      this.setStatus(`Registry read failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(`Registry read failed: ${describeError(err)}`);
    }
  }

  private async clearRegistry(): Promise<void> {
    const creds = await this.creds();
    if (!creds) { return; }
    // Destructive and not undoable: wipes stored subscription and login state.
    const choice = await vscode.window.showWarningMessage(
      `Delete the dev channel's entire registry on ${creds.ip}?`,
      { modal: true, detail: 'This erases saved logins, subscription state and preferences on the device. It cannot be undone.' },
      'Delete registry'
    );
    if (choice !== 'Delete registry') { return; }
    try {
      await ecp.deleteRegistry(creds);
      this.setStatus('Registry deleted.');
    } catch (err) {
      this.setStatus(`Registry delete failed: ${describeError(err)}`);
    }
  }

  // ---- history --------------------------------------------------------------

  private async showHistory(): Promise<void> {
    const entries = await this.history.prune();
    this.refresh();
    if (!entries.length) {
      void vscode.window.showInformationMessage('No retained packages yet. Deploy once to start the history.');
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        ...entries.map((e) => ({
          label: `$(history) ${describeEntry(e)}`,
          description: e.deviceName,
          entry: e,
          clear: false
        })),
        { label: '$(trash) Clear history', description: `${entries.length} package(s)`, entry: undefined, clear: true }
      ],
      { title: 'Deploy history', placeHolder: 'Pick a build to put back on the device' }
    );
    if (!choice) { return; }

    if (choice.clear) {
      await this.history.clear();
      this.setStatus('Deploy history cleared.');
      return;
    }

    const entry = choice.entry!;
    const creds = await this.creds();
    if (!creds) { return; }

    this.deploying = true;
    this.setStatus(`Redeploying ${describeEntry(entry)}…`);
    this.debugConsole.show();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Redeploying to ${creds.ip}` },
        () => install(entry.file, creds.ip, creds.user, creds.password, (l) => this.debugConsole.log(l))
      );
      this.setStatus(`Redeployed ${describeEntry(entry)}.`);
      if (this.config().get<boolean>('autoReconnectConsole', true)) {
        this.debugConsole.connect(creds.ip, false);
      }
    } catch (err) {
      this.setStatus(`Redeploy failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(`Redeploy failed: ${describeError(err)}`);
    } finally {
      this.deploying = false;
      this.refresh();
    }
  }

  // ---- overlays -------------------------------------------------------------

  /** The "overlay": a command-palette-style sheet over the editor. */
  private async quickPick(): Promise<void> {
    if (!this.requireEnabled()) { return; }
    const device = this.devices.find((d) => d.ip === this.selectedIp);
    const items: (vscode.QuickPickItem & { run: () => void | Promise<void> })[] = [
      {
        label: '$(rocket) Deploy to Roku',
        description: device ? `${device.name} · ${device.ip}` : this.selectedIp ?? 'no device selected',
        run: () => this.deploy()
      },
      {
        label: this.watcher.active ? '$(eye-closed) Turn watch mode off' : '$(eye) Turn watch mode on',
        description: 'Redeploy on save',
        run: () => this.toggleWatch()
      },
      {
        label: this.debugConsole.connected ? '$(debug-disconnect) Disconnect debug console' : '$(plug) Connect debug console',
        run: () => (this.debugConsole.connected ? this.debugConsole.disconnect() : this.connectConsole())
      },
      { label: '$(output) Show debug output', run: () => this.debugConsole.show() },
      { label: '$(device-camera) Capture screenshot', run: () => this.screenshot() },
      { label: '$(play-circle) Open live preview', description: '~1 fps, with keyboard', run: () => this.showLiveView() },
      { label: '$(clear-all) Clear saved screenshots', run: () => this.clearScreenshots() },
      { label: '$(symbol-keyword) Remote control…', run: () => this.remoteQuickPick() },
      { label: '$(debug-restart) Relaunch dev channel', run: () => this.relaunch() },
      { label: '$(database) Inspect registry', run: () => this.showRegistry() },
      { label: '$(trash) Delete registry', run: () => this.clearRegistry() },
      { label: '$(history) Deploy history…', run: () => this.showHistory() },
      { label: '$(search) Scan network', run: () => this.scan() },
      { label: '$(globe) Open device web UI', run: () => this.openWebUI() },
      { label: '$(list-selection) Switch device', run: () => this.pickDevice() },
      { label: '$(gear) Open Roku Studio settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'rokuStudio') }
    ];

    const choice = await vscode.window.showQuickPick(items, {
      title: 'Roku Studio',
      placeHolder: device ? `${device.name} (${device.ip})` : 'No device selected'
    });
    await choice?.run();
  }

  private async remoteQuickPick(): Promise<void> {
    if (!this.selectedIp) {
      void vscode.window.showWarningMessage('Select a Roku device first.');
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        ...ecp.REMOTE_KEYS.map((key) => ({ label: `$(circle-small-filled) ${key}`, key, text: false })),
        { label: '$(edit) Send text…', key: '', text: true }
      ],
      { title: `Remote: ${this.selectedIp}`, placeHolder: 'Pick a key to send' }
    );
    if (!choice) { return; }
    if (choice.text) {
      const text = await vscode.window.showInputBox({ prompt: 'Text to send to the device' });
      if (text) { await this.sendText(text); }
      return;
    }
    await this.sendKey(choice.key);
  }

  private async pickDevice(): Promise<void> {
    if (!this.devices.length) {
      await this.scan();
      if (!this.devices.length) { return; }
    }
    const choice = await vscode.window.showQuickPick(
      this.devices.map((d) => ({
        label: d.name,
        description: d.ip,
        detail: `${d.model || 'Roku'}${d.devMode ? '' : ' · developer mode off'}`,
        ip: d.ip
      })),
      { placeHolder: 'Select a Roku device' }
    );
    if (choice) { await this.select(choice.ip); }
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
  }
}

/** DOM key name to ECP key, for the sidebar capture pad. Space is absent on
 *  purpose: it must be typed as a literal character, not sent as Play. */
const PAD_KEY_MAP: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Select',
  Escape: 'Back',
  Backspace: 'Backspace',
  Home: 'Home',
  F1: 'Home',
  F2: 'Back',
  F3: 'Rev',
  F4: 'Play',
  F5: 'Fwd',
  F6: 'InstantReplay',
  F7: 'Info'
};

function describeError(err: unknown): string {
  if (err instanceof Error) { return err.message; }
  return String(err);
}
