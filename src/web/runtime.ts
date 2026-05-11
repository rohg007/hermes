export type WebRuntime = 'cpu' | 'gpu' | 'auto';
export type WebResolvedRuntime = Exclude<WebRuntime, 'auto'>;

export type WebRuntimeCapabilities = {
  cpu: {
    available: boolean;
    arch: string;
    neon: boolean;
    avx2: boolean;
    wasmSimd?: boolean;
    threadCount: number;
  };
  gpu: {
    available: boolean;
    compiled: boolean;
    api?: string;
    reason?: string;
  };
};

export type WebRuntimeSelection = {
  runtime: WebResolvedRuntime;
  warnings: string[];
};

export class WebUnsupportedRuntimeError extends Error {
  constructor(message: string) {
    super(`BITNET_RUNTIME_UNSUPPORTED: ${message}`);
    this.name = 'UnsupportedRuntimeError';
  }
}

type WebRuntimeScope = {
  navigator?: unknown;
  crossOriginIsolated?: boolean;
};

let webWasmThreadsEnabled = false;
let webWasmThreadCount: number | undefined;

export function configureWebRuntime(options: { webThreads?: boolean; webThreadCount?: number } = {}): void {
  webWasmThreadsEnabled = options.webThreads ?? false;
  webWasmThreadCount =
    typeof options.webThreadCount === 'number' && options.webThreadCount > 0
      ? Math.floor(options.webThreadCount)
      : undefined;
}

function detectWebThreadCount(scope: WebRuntimeScope): number {
  if (!webWasmThreadsEnabled) {
    return 1;
  }
  const navigator = scope.navigator as { hardwareConcurrency?: number } | undefined;
  const supportsSharedMemory = typeof SharedArrayBuffer !== 'undefined' && scope.crossOriginIsolated === true;
  if (!supportsSharedMemory) {
    return 1;
  }
  return Math.max(1, Math.min(4, webWasmThreadCount ?? navigator?.hardwareConcurrency ?? 1));
}

export function detectWebRuntimeCapabilities(scope: WebRuntimeScope = globalThis): WebRuntimeCapabilities {
  const navigator = scope.navigator as { gpu?: unknown } | undefined;
  const webgpu = Boolean(navigator?.gpu);
  return {
    cpu: {
      available: true,
      arch: 'wasm32',
      neon: false,
      avx2: false,
      wasmSimd: true,
      threadCount: detectWebThreadCount(scope),
    },
    gpu: {
      available: false,
      compiled: false,
      api: webgpu ? 'webgpu' : '',
      reason: webgpu
        ? 'WebGPU was detected, but the BitNet WebGPU backend is not implemented in this WASM build.'
        : 'navigator.gpu is unavailable; using WASM CPU.',
    },
  };
}

export function selectWebRuntime(
  runtime: WebRuntime,
  capabilities: WebRuntimeCapabilities
): WebRuntimeSelection {
  if (runtime === 'cpu') {
    return { runtime: 'cpu', warnings: [] };
  }

  if (runtime === 'auto') {
    // Web keeps a single stable production backend today. Auto preserves API
    // consistency while allowing future WebGPU promotion behind capabilities.
    const warnings = capabilities.gpu.reason
      ? [`Web GPU runtime unavailable; using WASM CPU. ${capabilities.gpu.reason}`]
      : [];
    return { runtime: 'cpu', warnings };
  }

  throw new WebUnsupportedRuntimeError(capabilities.gpu.reason || 'WebGPU backend is unavailable.');
}
