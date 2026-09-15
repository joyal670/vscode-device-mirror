import { EventEmitter } from 'events';
import { adbExec } from './adb';

/**
 * Tier 0 backend: poll `adb exec-out screencap -p`.
 *
 * Roughly 1-3 fps and no input, but it needs nothing beyond adb — useful for
 * proving the webview, device discovery and the bridge before adding a codec.
 */
export class ScreencapSession extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private disposed = false;

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
          this.emit('frame', png);
        }
      } catch (err) {
        this.emit('log', `screencap failed: ${err}`);
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
