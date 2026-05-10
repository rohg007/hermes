import { WebBitNetModule } from './WebBitNetModule';
import { configureBitNet } from '../config';

export interface BitNetWebConfig {
  wasmModuleUrl?: string;
  webDebug?: boolean;
  webThreads?: boolean;
  webThreadCount?: number;
}

export async function configureBitNetWeb(config: BitNetWebConfig = {}): Promise<void> {
  const next = configureBitNet({
    wasmModuleUrl: config.wasmModuleUrl,
    webDebug: config.webDebug,
    webThreads: config.webThreads,
    webThreadCount: config.webThreadCount,
  });
  await WebBitNetModule.configure({
    wasmModuleUrl: next.wasmModuleUrl,
    webDebug: next.webDebug,
    webThreads: next.webThreads,
    webThreadCount: next.webThreadCount,
  });
}
