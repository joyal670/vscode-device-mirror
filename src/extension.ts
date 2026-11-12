import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Device, findAdb, isNotFound, listDevices } from './adb';
import { DevicesView } from './devicesView';
import { MirrorPanel } from './panel';
import * as tools from './tools';

let output: vscode.OutputChannel;

/** Active screen recordings, by serial. */
const recordings = new Map<string, tools.ScreenRecorder>();

/**
 * What commands receive as their first argument: a tree item or a panel's
 * `{ device }` (both have `.device`), an Explorer file Uri, or nothing when
 * run from the palette.
 */
type CommandArg = { device?: Device } | vscode.Uri | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Device Mirror');
  context.subscriptions.push(output);

  const view = new DevicesView(
    (serial) => !!MirrorPanel.forSerial(serial),
    (serial) => recordings.has(serial),
  );
  context.subscriptions.push(view);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'deviceMirror.start';
  context.subscriptions.push(status);
  const updateStatus = () => {
    const mirrors = MirrorPanel.all();
    const recording = recordings.size > 0;
    status.text = `$(${recording ? 'record' : 'device-mobile'}) ${
      mirrors.length === 0
        ? 'Mirror'
        : mirrors.length === 1
          ? mirrors[0].device.model ?? mirrors[0].device.serial
          : `${mirrors.length} devices`
    }`;
    status.tooltip =
      mirrors.length === 0
        ? 'Device Mirror: start mirroring an Android device'
        : `Mirroring: ${mirrors.map((p) => p.device.model ?? p.device.serial).join(', ')}${
            recording ? ' · recording' : ''
          }\nClick to mirror another device`;
    status.show();
    view.rerender();
  };
  updateStatus();
  context.subscriptions.push(MirrorPanel.onDidChange(updateStatus));

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('deviceMirror.start', async (arg?: CommandArg) => {
    const adb = await adbOrReport();
    if (!adb) return;
    const device = argDevice(arg) ?? (await pickDevice(adb, 'Select a device to mirror', false));
    if (device) {
      await MirrorPanel.show(context, adb, device, output);
    }
  });

  register('deviceMirror.stop', async (arg?: CommandArg) => {
    // Close a mirror specifically — never whatever editor happens to have focus.
    const fromArg = argDevice(arg);
    const target = fromArg ? MirrorPanel.forSerial(fromArg.serial) : MirrorPanel.active();
    if (target) {
      await target.dispose();
      return;
    }
    const open = MirrorPanel.all();
    if (open.length === 1) {
      await open[0].dispose();
    } else if (open.length > 1) {
      const picked = await vscode.window.showQuickPick(
        open.map((p) => ({ label: p.device.model ?? p.device.serial, description: p.device.serial, p })),
        { placeHolder: 'Stop mirroring which device?' },
      );
      await picked?.p.dispose();
    }
  });

  register('deviceMirror.screenshot', async (arg?: CommandArg) => {
    const adb = await adbOrReport();
    if (!adb) return;
    const device = await targetDevice(adb, arg, 'Take a screenshot of which device?');
    if (!device) return;
    const png = await withProgress('Taking screenshot…', () => tools.screenshot(adb, device.serial));
    if (!png) return;
    const uri = await saveDialog(context, device, 'png', 'PNG image');
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, png);
    void offerToOpen(`Screenshot saved to ${path.basename(uri.fsPath)}.`, uri);
  });

  register('deviceMirror.toggleRecording', async (arg?: CommandArg) => {
    const adb = await adbOrReport();
    if (!adb) return;
    // Explicit device, else the focused mirror's. With neither, a single
    // running recording is what the user most likely wants to stop.
    let device = argDevice(arg) ?? MirrorPanel.active()?.device;
    if (!device && recordings.size === 1) {
      const [only] = recordings.values();
      await stopRecording(context, only, updateStatus);
      return;
    }
    device ??= await pickDevice(adb, 'Record which device?', true);
    if (!device) return;

    const running = recordings.get(device.serial);
    if (running) {
      await stopRecording(context, running, updateStatus);
    } else {
      startRecording(context, adb, device, updateStatus);
    }
  });

  register('deviceMirror.installApk', async (arg?: CommandArg, all?: vscode.Uri[]) => {
    const adb = await adbOrReport();
    if (!adb) return;
    const files = argFiles(arg, all) ?? (await openDialog('Install', { 'Android package': ['apk'] }));
    if (!files?.length) return;
    const device = await targetDevice(adb, argDevice(arg) ? arg : undefined, 'Install on which device?');
    if (!device) return;
    for (const file of files) {
      const name = path.basename(file.fsPath);
      const ok = await withProgress(`Installing ${name} on ${label(device)}…`, () =>
        tools.installApk(adb, device.serial, file.fsPath).then(() => true),
      );
      if (ok) void vscode.window.showInformationMessage(`Installed ${name} on ${label(device)}.`);
    }
  });

  register('deviceMirror.pushFile', async (arg?: CommandArg, all?: vscode.Uri[]) => {
    const adb = await adbOrReport();
    if (!adb) return;
    const files = argFiles(arg, all) ?? (await openDialog('Push', undefined, true));
    if (!files?.length) return;
    const device = await targetDevice(adb, argDevice(arg) ? arg : undefined, 'Push to which device?');
    if (!device) return;
    for (const file of files) {
      const name = path.basename(file.fsPath);
      const remote = await withProgress(`Pushing ${name} to ${label(device)}…`, () =>
        tools.pushFile(adb, device.serial, file.fsPath),
      );
      if (remote) void vscode.window.showInformationMessage(`Copied ${name} to ${remote} on ${label(device)}.`);
    }
  });

  register('deviceMirror.pairWifi', async () => {
    const adb = await adbOrReport();
    if (!adb) return;
    const hostPort = await vscode.window.showInputBox({
      title: 'Pair over Wi-Fi (1/3)',
      prompt:
        'On the device: Developer options › Wireless debugging › Pair device with pairing code. Enter the IP address & port shown there.',
      placeHolder: '192.168.1.20:37123',
      validateInput: validateHostPort,
      ignoreFocusOut: true,
    });
    if (!hostPort) return;
    const code = await vscode.window.showInputBox({
      title: 'Pair over Wi-Fi (2/3)',
      prompt: 'Enter the six-digit Wi-Fi pairing code shown on the device.',
      validateInput: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : 'Six digits'),
      ignoreFocusOut: true,
    });
    if (!code) return;
    const paired = await withProgress('Pairing…', () => tools.pairWifi(adb, hostPort.trim(), code.trim()).then(() => true));
    if (!paired) return;

    // The pairing port is single-use; connecting needs the main port, which
    // is on the Wireless debugging screen itself.
    const connectTo = await vscode.window.showInputBox({
      title: 'Pair over Wi-Fi (3/3)',
      prompt: 'Paired. Now enter the IP address & port shown at the top of the Wireless debugging screen (not the pairing port).',
      value: `${hostPort.split(':')[0]}:`,
      valueSelection: [hostPort.split(':')[0].length + 1, hostPort.split(':')[0].length + 1],
      validateInput: validateHostPort,
      ignoreFocusOut: true,
    });
    if (!connectTo) return;
    if (await withProgress('Connecting…', () => tools.connectWifi(adb, connectTo.trim()).then(() => true))) {
      void vscode.window.showInformationMessage(`Connected to ${connectTo.trim()}.`);
      void view.refresh();
    }
  });

  register('deviceMirror.connectWifi', async () => {
    const adb = await adbOrReport();
    if (!adb) return;
    const hostPort = await vscode.window.showInputBox({
      title: 'Connect over Wi-Fi',
      prompt: 'IP address & port of a device with Wireless debugging (or adb tcpip) enabled.',
      placeHolder: '192.168.1.20:5555',
      validateInput: validateHostPort,
      ignoreFocusOut: true,
    });
    if (!hostPort) return;
    if (await withProgress('Connecting…', () => tools.connectWifi(adb, hostPort.trim()).then(() => true))) {
      void vscode.window.showInformationMessage(`Connected to ${hostPort.trim()}.`);
      void view.refresh();
    }
  });

  register('deviceMirror.switchToWifi', async (arg?: CommandArg) => {
    const adb = await adbOrReport();
    if (!adb) return;
    const device =
      argDevice(arg) ??
      (await pickDevice(adb, 'Switch which USB device to Wi-Fi?', false, (d) => !/:\d+$/.test(d.serial)));
    if (!device) return;
    const serial = await withProgress(`Switching ${label(device)} to Wi-Fi…`, () =>
      tools.switchToWifi(adb, device.serial),
    );
    if (serial) {
      void vscode.window.showInformationMessage(
        `${label(device)} is now also available over Wi-Fi as ${serial}. You can unplug the cable.`,
      );
      void view.refresh();
    }
  });

  register('deviceMirror.refreshDevices', () => view.refresh());
}

/**
 * Returning the promise makes VS Code wait (briefly) for teardown, so the
 * `adb forward --remove` actually runs on window reload instead of leaking.
 */
export async function deactivate(): Promise<void> {
  await Promise.all([
    MirrorPanel.disposeAll(),
    // Stop on-device recorders so they don't keep running unattended.
    ...[...recordings.values()].map((r) => r.stop().then(() => r.discard())),
  ]);
}

// ------------------------------------------------------------------ helpers

async function adbOrReport(): Promise<string | undefined> {
  const adb = findAdb();
  try {
    await listDevices(adb);
    return adb;
  } catch (err) {
    reportAdbError(err);
    return undefined;
  }
}

function reportAdbError(err: unknown): void {
  if (isNotFound(err)) {
    const configured = vscode.workspace.getConfiguration('deviceMirror').get<string>('adbPath');
    void vscode.window.showErrorMessage(
      configured
        ? `Device Mirror: adb not found at "${configured}". Fix deviceMirror.adbPath.`
        : 'Device Mirror: adb not found. Install Android SDK platform-tools, or set deviceMirror.adbPath.',
    );
  } else {
    void vscode.window.showErrorMessage(`Device Mirror: adb failed — ${err}`);
  }
}

function argDevice(arg: CommandArg): Device | undefined {
  return arg && !(arg instanceof vscode.Uri) ? arg.device : undefined;
}

/** Explorer passes the clicked file plus the full multi-selection. */
function argFiles(arg: CommandArg, all?: vscode.Uri[]): vscode.Uri[] | undefined {
  if (all?.length) return all;
  return arg instanceof vscode.Uri ? [arg] : undefined;
}

/**
 * The device a command should act on: an explicit one, else the focused
 * mirror's, else the only ready device, else ask.
 */
async function targetDevice(adb: string, arg: CommandArg, placeHolder: string): Promise<Device | undefined> {
  return argDevice(arg) ?? MirrorPanel.active()?.device ?? (await pickDevice(adb, placeHolder, true));
}

async function pickDevice(
  adb: string,
  placeHolder: string,
  autoPickSingle: boolean,
  filter: (d: Device) => boolean = () => true,
): Promise<Device | undefined> {
  let devices: Device[];
  try {
    devices = await listDevices(adb);
  } catch (err) {
    reportAdbError(err);
    return undefined;
  }
  const ready = devices.filter((d) => d.state === 'device' && filter(d));

  if (ready.length === 0) {
    const unauthorised = devices.some((d) => d.state === 'unauthorized');
    const offline = devices.some((d) => d.state === 'offline');
    void vscode.window.showWarningMessage(
      unauthorised
        ? 'Device Mirror: device connected but not authorised. Accept the "Allow USB debugging" prompt on the device.'
        : offline
          ? 'Device Mirror: device is offline. Unplug and reconnect it, or run "adb kill-server".'
          : 'Device Mirror: no device detected. Connect one over USB with USB debugging enabled, or pair it over Wi-Fi.',
    );
    return undefined;
  }
  if (ready.length === 1 && (autoPickSingle || !MirrorPanel.forSerial(ready[0].serial))) {
    return ready[0];
  }
  const picked = await vscode.window.showQuickPick(
    ready.map((device) => ({
      label: device.model ?? device.serial,
      description: device.serial,
      detail: MirrorPanel.forSerial(device.serial) ? 'Already mirroring' : undefined,
      device,
    })),
    { placeHolder, matchOnDescription: true },
  );
  return picked?.device;
}

function label(device: Device): string {
  return device.model ?? device.serial;
}

/** Recorders we are stopping ourselves; their 'stopped' event is expected. */
const stopping = new WeakSet<tools.ScreenRecorder>();

function startRecording(
  context: vscode.ExtensionContext,
  adb: string,
  device: Device,
  onChange: () => void,
): void {
  const recorder = new tools.ScreenRecorder(adb, device.serial);
  recordings.set(device.serial, recorder);
  recorder.on('stopped', (error?: string) => {
    // Covers screenrecord's own 3-minute limit as well as our stop().
    if (recordings.get(device.serial) === recorder && !stopping.has(recorder)) {
      recordings.delete(device.serial);
      MirrorPanel.forSerial(device.serial)?.setRecording(undefined);
      onChange();
      if (error) {
        output.appendLine(`[${device.serial}] screenrecord: ${error}`);
        void vscode.window.showErrorMessage(`Device Mirror: recording stopped — ${error}`);
      } else {
        void vscode.window
          .showInformationMessage(`Recording on ${label(device)} reached its time limit.`, 'Save…')
          .then((choice) => (choice ? saveRecording(context, recorder, device) : recorder.discard()));
      }
    }
  });
  recorder.start();
  MirrorPanel.forSerial(device.serial)?.setRecording(recorder.startedAt);
  onChange();
}

async function stopRecording(
  context: vscode.ExtensionContext,
  recorder: tools.ScreenRecorder,
  onChange: () => void,
): Promise<void> {
  stopping.add(recorder);
  recordings.delete(recorder.serial);
  MirrorPanel.forSerial(recorder.serial)?.setRecording(undefined);
  onChange();
  await withProgress('Finishing recording…', () => recorder.stop());
  const device = MirrorPanel.forSerial(recorder.serial)?.device ?? { serial: recorder.serial, state: 'device' };
  await saveRecording(context, recorder, device);
}

async function saveRecording(
  context: vscode.ExtensionContext,
  recorder: tools.ScreenRecorder,
  device: Device,
): Promise<void> {
  const uri = await saveDialog(context, device, 'mp4', 'MP4 video');
  if (!uri) {
    await recorder.discard();
    return;
  }
  const ok = await withProgress('Saving recording…', () => recorder.saveTo(uri.fsPath).then(() => true));
  if (ok) void offerToOpen(`Recording saved to ${path.basename(uri.fsPath)}.`, uri);
}

const LAST_SAVE_DIR = 'deviceMirror.lastSaveDir';

async function saveDialog(
  context: vscode.ExtensionContext,
  device: Device,
  ext: string,
  filterName: string,
): Promise<vscode.Uri | undefined> {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
  const name = `${(device.model ?? device.serial).replace(/[^\w.-]+/g, '_')}-${stamp}.${ext}`;
  const dir =
    context.globalState.get<string>(LAST_SAVE_DIR) ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    os.homedir();
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, name)),
    filters: { [filterName]: [ext] },
  });
  if (uri) await context.globalState.update(LAST_SAVE_DIR, path.dirname(uri.fsPath));
  return uri;
}

async function openDialog(
  verb: string,
  filters?: Record<string, string[]>,
  many = true,
): Promise<vscode.Uri[] | undefined> {
  return vscode.window.showOpenDialog({ canSelectMany: many, openLabel: verb, filters });
}

async function offerToOpen(message: string, uri: vscode.Uri): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, 'Open', 'Reveal');
  if (choice === 'Open') {
    await vscode.commands.executeCommand('vscode.open', uri);
  } else if (choice === 'Reveal') {
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }
}

/** Run with a progress toast; reports failures and resolves undefined. */
async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      task,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`${title} failed: ${message}`);
    void vscode.window.showErrorMessage(`Device Mirror: ${message}`);
    return undefined;
  }
}

function validateHostPort(value: string): string | undefined {
  return /^[\w.-]+:\d{1,5}$/.test(value.trim()) ? undefined : 'Expected host:port, e.g. 192.168.1.20:5555';
}
