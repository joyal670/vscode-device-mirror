// Lets modules that `import * as vscode from 'vscode'` load under plain Node.
// Import this before the module under test. Only the API surface those
// modules touch at call time is provided.
import Module from 'node:module';

/** deviceMirror.* settings returned by the stubbed getConfiguration(). */
export const settings: Record<string, unknown> = {};

const stub = {
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback?: T): T | undefined =>
        key in settings ? (settings[key] as T) : fallback,
    }),
  },
};

type Loader = (request: string, ...rest: unknown[]) => unknown;
const loader = Module as unknown as { _load: Loader };
const original = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? stub : original.call(this, request, ...rest);
};
