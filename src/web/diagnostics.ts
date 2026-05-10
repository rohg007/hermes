export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let webDiagnosticsEnabled = false;

export function setWebDiagnosticsEnabled(enabled: boolean): void {
  webDiagnosticsEnabled = enabled;
}

export function webLog(message: string): void {
  if (!webDiagnosticsEnabled) {
    return;
  }
  console.info(`[BitNet Web] ${message}`);
}

export function webNativeLog(message: string): void {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('failed') ||
    normalized.includes('error') ||
    normalized.includes('abort') ||
    normalized.includes('assert') ||
    normalized.includes('exception') ||
    normalized.includes('out of memory')
  ) {
    console.error(`[BitNet WASM] ${message}`);
    return;
  }
  if (
    normalized.includes('warning') ||
    normalized.includes('not marked as eog') ||
    normalized.includes('may be incorrect')
  ) {
    if (webDiagnosticsEnabled) {
      console.warn(`[BitNet WASM] ${message}`);
    }
    return;
  }
  if (webDiagnosticsEnabled) {
    console.info(`[BitNet WASM] ${message}`);
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
