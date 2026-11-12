import { EventEmitter } from 'events';
import { adbExec } from './adb';

/**
 * Tier 0 backend: poll `adb exec-out screencap -p`.
 *
 * Roughly 1-3 fps and no input, but it needs nothing beyond adb — useful for
 * proving the webview, device discovery and the bridge before adding a codec.
 *
 * Emits 'frame' (PNG Buffer), 'log' (string), and 'close' once after three
 * consecutive capture failures.
 */
export class ScreencapSession extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private disposed = false;
  private failures = 0;

  constructor(
    private readonly adb: string,
    private readonly serial: string,
    private readonly intervalMs = 400,
  ) {
    super();
  }

  start(): void {
    const tick = async () => {
      if (this.busy || this.disposed) return;
      this.busy = true;
      try {
        const png = await adbExec(this.adb, [
          '-s', this.serial, 'exec-out', 'screencap', '-p',
        ]);
        if (!this.disposed && png.length > 0) {
          this.failures = 0;
          this.emit('frame', png);
        }
      } catch (err) {
        if (this.disposed) return;
        this.emit('log', `screencap failed: ${err}`);
        // One failure can be a hiccup; several in a row means the device is
        // gone. Stop polling and let the panel handle reconnection.
        if (++this.failures >= 3) {
          this.dispose();
          this.emit('close');
        }
      } finally {
        this.busy = false;
      }
    };

    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
