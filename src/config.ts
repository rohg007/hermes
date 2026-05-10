import type { BitNetConfiguration, BitNetRuntime } from './types';

export const DEFAULT_WEB_WASM_MODULE_URL = '/bitnet_wasm.js';

let currentConfig: Required<Pick<BitNetConfiguration, 'runtime' | 'wasmModuleUrl'>> &
  Omit<BitNetConfiguration, 'runtime' | 'wasmModuleUrl'> = {
  runtime: 'cpu',
  wasmModuleUrl: DEFAULT_WEB_WASM_MODULE_URL,
};

export function configureBitNet(config: BitNetConfiguration = {}): BitNetConfiguration {
  currentConfig = {
    ...currentConfig,
    ...config,
    runtime: config.runtime ?? currentConfig.runtime,
    wasmModuleUrl: config.wasmModuleUrl ?? currentConfig.wasmModuleUrl,
    webDebug: config.webDebug ?? currentConfig.webDebug,
    webThreads: config.webThreads ?? currentConfig.webThreads,
    webThreadCount: config.webThreadCount ?? currentConfig.webThreadCount,
  };
  return getBitNetConfig();
}

export function getBitNetConfig(): BitNetConfiguration {
  return { ...currentConfig };
}

export function getDefaultRuntime(): BitNetRuntime {
  return currentConfig.runtime;
}
