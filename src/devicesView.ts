import * as vscode from 'vscode';
import { Device, findAdb, listDevices } from './adb';

const POLL_MS = 3000;

/** A network serial looks like host:port; everything else is USB (or emulator). */
export function isNetworkSerial(serial: string): boolean {
  return /^[^:]+:\d+$/.test(serial);
}

export class DeviceItem extends vscode.TreeItem {
  constructor(
    readonly device: Device,
    mirroring: boolean,
    recording: boolean,
  ) {
    super(device.model ?? device.serial, vscode.TreeItemCollapsibleState.None);
    const ready = device.state === 'device';
    const transport = isNetworkSerial(device.serial) ? 'wifi' : 'usb';

    const notes: string[] = [];
    if (!ready) notes.push(STATE_LABELS[device.state] ?? device.state);
    if (mirroring) notes.push('mirroring');
    if (recording) notes.push('recording');
    this.description = [device.serial, ...notes].join(' · ');

    this.tooltip = new vscode.MarkdownString(
      [
        `**${device.model ?? device.serial}**`,
        `Serial: \`${device.serial}\``,
        `Connection: ${transport === 'wifi' ? 'Wi-Fi' : 'USB'}`,
        `State: ${STATE_LABELS[device.state] ?? device.state}`,
        ready ? '' : STATE_HELP[device.state] ?? '',
      ]
        .filter(Boolean)
        .join('  \n'),
    );

    this.iconPath = new vscode.ThemeIcon(
      recording ? 'record' : transport === 'wifi' ? 'radio-tower' : 'device-mobile',
      ready ? undefined : new vscode.ThemeColor('disabledForeground'),
    );

    // Matched by regexes in package.json menus: device-<ready|other>-<usb|wifi>[-mirroring]
    this.contextValue = [
      'device',
      ready ? 'ready' : 'unavailable',
      transport,
      mirroring ? 'mirroring' : undefined,
    ]
      .filter(Boolean)
      .join('-');

    if (ready && !mirroring) {
      this.command = {
        command: 'deviceMirror.start',
        title: 'Start Mirroring',
        arguments: [this],
      };
    }
  }
}

const STATE_LABELS: Record<string, string> = {
  device: 'ready',
  unauthorized: 'unauthorised',
  offline: 'offline',
  authorizing: 'authorising',
  connecting: 'connecting',
};

const STATE_HELP: Record<string, string> = {
  unauthorized: 'Accept the "Allow USB debugging" prompt on the device.',
  offline: 'Reconnect the device, or run `adb kill-server`.',
};

/**
 * Lists adb devices. Polls only while the view is visible — no point running
 * `adb devices` every few seconds for a collapsed panel.
 */
export class DevicesView implements vscode.TreeDataProvider<DeviceItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly tree: vscode.TreeView<DeviceItem>;
  private timer?: NodeJS.Timeout;
  private lastSnapshot = '';
  private devices: Device[] = [];
  private error?: string;

  constructor(
    private readonly isMirroring: (serial: string) => boolean,
    private readonly isRecording: (serial: string) => boolean,
  ) {
    this.tree = vscode.window.createTreeView('deviceMirror.devices', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.tree.onDidChangeVisibility((e) => (e.visible ? this.startPolling() : this.stopPolling()));
    if (this.tree.visible) this.startPolling();
  }

  /** Re-read adb now (and re-render even if the device list is unchanged). */
  async refresh(): Promise<void> {
    await this.poll(true);
  }

  /** Re-render without hitting adb, e.g. after a mirror starts or stops. */
  rerender(): void {
    this.changed.fire();
  }

  getTreeItem(item: DeviceItem): vscode.TreeItem {
    return item;
  }

  getChildren(): DeviceItem[] {
    if (this.error) {
      this.tree.message = this.error;
      return [];
    }
    this.tree.message = undefined;
    return this.devices.map(
      (d) => new DeviceItem(d, this.isMirroring(d.serial), this.isRecording(d.serial)),
    );
  }

  private startPolling(): void {
    if (this.timer) return;
    void this.poll(true);
    this.timer = setInterval(() => void this.poll(false), POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(force: boolean): Promise<void> {
    let devices: Device[] = [];
    let error: string | undefined;
    try {
      devices = await listDevices(findAdb());
    } catch (err) {
      error =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'adb not found. Install Android SDK platform-tools or set deviceMirror.adbPath.'
          : `adb failed: ${err}`;
    }
    // transport_id is deliberately excluded: it changes on reconnect but the
    // row doesn't need to re-render for that.
    const snapshot = JSON.stringify([error, devices.map((d) => [d.serial, d.state, d.model])]);
    if (!force && snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.devices = devices;
    this.error = error;
    this.changed.fire();
  }

  dispose(): void {
    this.stopPolling();
    this.tree.dispose();
    this.changed.dispose();
  }
}
