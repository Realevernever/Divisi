import { renameSync } from "node:fs";

const retryWaiter = new Int32Array(new SharedArrayBuffer(4));
const windowsReplaceErrors = new Set(["EACCES", "EBUSY", "EPERM"]);

export function replaceFileSync(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (
        process.platform !== "win32" ||
        code === undefined ||
        !windowsReplaceErrors.has(code) ||
        attempt >= 19
      ) {
        throw error;
      }
      Atomics.wait(retryWaiter, 0, 0, 10);
    }
  }
}
