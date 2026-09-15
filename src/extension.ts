import * as vscode from 'vscode';
import { Device, findAdb, listDevices } from './adb';
import { MirrorPanel } from './panel';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Device Mirror');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('deviceMirror.start', async () => {
      const adb = findAdb();
      if (!adb) {
        void vscode.window.showErrorMessage(
          'Device Mirror: adb not found. Set deviceMirror.adbPath.',
        );
        return;
      }

      let devices: Device[];
      try {
        devices = await listDevices(adb);
      } catch (err) {
        void vscode.window.showErrorMessage(`Device Mirror: adb failed — ${err}`);
        return;
      }

      const ready = devices.filter((d) => d.state === 'device');

      if (ready.length === 0) {
        const unauthorised = devices.filter((d) => d.state === 'unauthorized');
        const offline = devices.filter((d) => d.state === 'offline');
        let message: string;
        if (unauthorised.length > 0) {
          message =
            'Device Mirror: device connected but not authorised. Accept the "Allow USB debugging" prompt on the device.';
        } else if (offline.length > 0) {
          message =
            'Device Mirror: device is offline. Unplug and reconnect it, or run "adb kill-server".';
        } else {
          message =
            'Device Mirror: no device detected. Connect one over USB with USB debugging enabled, or pair it over Wi-Fi with "adb connect".';
        }
        void vscode.window.showWarningMessage(message);
        return;
      }

      const device = ready.length === 1 ? ready[0] : await pickDevice(ready);
      if (!device) {
        return;
      }

      await MirrorPanel.show(context, adb, device, output);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('deviceMirror.stop', () => {
      void vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }),
  );
}

async function pickDevice(devices: Device[]): Promise<Device | undefined> {
  const picked = await vscode.window.showQuickPick(
    devices.map((device) => ({
      label: device.model ?? device.serial,
      description: device.serial,
      device,
    })),
    { placeHolder: 'Select a device to mirror' },
  );
  return picked?.device;
}

export function deactivate(): void {
  // MirrorPanel tears down its own sockets, process and adb forward on dispose.
}
