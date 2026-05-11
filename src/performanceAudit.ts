import { getBitNetLogger } from './logger';
import type { BitNetMetrics, BitNetResolvedRuntime, RuntimeCapabilities } from './types';

function boolLabel(value: boolean | undefined): string {
  return value ? 'yes' : 'no';
}

function numberLabel(value: number | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function msLabel(value: number | undefined): string {
  return `${numberLabel(value, 1)}ms`;
}

function mbLabel(value: number | undefined): string {
  return `${numberLabel(value, 1)}MB`;
}

function pathBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path;
}

function inferModelHints(modelId: string, path: string): string {
  const value = `${modelId} ${path}`.toLowerCase();
  const hints: string[] = [];
  if (value.includes('bitnet')) {
    hints.push('bitnet');
  }
  if (value.endsWith('.gguf') || value.includes('.gguf')) {
    hints.push('gguf');
  }
  if (value.includes('i2_s')) {
    hints.push('i2_s');
  }
  if (value.includes('tl1')) {
    hints.push('tl1');
  }
  if (value.includes('tl2')) {
    hints.push('tl2');
  }
  return hints.length > 0 ? hints.join('+') : 'unknown';
}

function simdLabel(capabilities: RuntimeCapabilities): string {
  const simd: string[] = [];
  if (capabilities.cpu.neon) {
    simd.push('neon');
  }
  if (capabilities.cpu.avx2) {
    simd.push('avx2');
  }
  if (capabilities.cpu.wasmSimd) {
    simd.push('wasm-simd');
  }
  return simd.length > 0 ? simd.join('+') : 'none';
}

export function logPerformanceAuditLoad(args: {
  modelId: string;
  path: string;
  requestedRuntime: string;
  runtimeUsed: BitNetResolvedRuntime;
  contextSize: number;
  requestedThreads: number;
  capabilities: RuntimeCapabilities;
}): void {
  const requestedThreads = args.requestedThreads > 0 ? String(args.requestedThreads) : 'auto';
  const logger = getBitNetLogger();
  logger.info(
    `[audit] load model=${args.modelId} file=${pathBasename(args.path)} hints=${inferModelHints(
      args.modelId,
      args.path
    )} runtime=${args.runtimeUsed} requestedRuntime=${args.requestedRuntime} context=${
      args.contextSize
    } threads=${requestedThreads}`
  );
  logger.info(
    `[audit] cpu arch=${args.capabilities.cpu.arch} simd=${simdLabel(args.capabilities)} hardwareThreads=${
      args.capabilities.cpu.threadCount
    }`
  );
  logger.info(
    `[audit] gpu compiled=${boolLabel(args.capabilities.gpu.compiled)} available=${boolLabel(
      args.capabilities.gpu.available
    )} api=${args.capabilities.gpu.api || 'none'} reason=${args.capabilities.gpu.reason || 'n/a'}`
  );
}

export function logPerformanceAuditMetrics(metrics: BitNetMetrics): void {
  getBitNetLogger().info(
    `[audit] generation model=${metrics.modelId} runtime=${metrics.runtimeUsed} generatedTokens=${
      metrics.generatedTokens
    } promptTokens=${metrics.promptTokens ?? 'n/a'} tps=${numberLabel(metrics.tokensPerSecond, 2)} latency=${msLabel(
      metrics.latencyMs
    )} firstToken=${msLabel(metrics.firstTokenLatencyMs)} memory=${mbLabel(metrics.memoryUsageMB)} threads=${
      metrics.threadCount ?? 'n/a'
    }`
  );
}
