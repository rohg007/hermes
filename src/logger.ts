export interface BitNetLogger {
  info(message: string): void;
  warn(message: string): void;
}

let logger: BitNetLogger = {
  info(message) {
    console.info(`[BitNet] ${message}`);
  },
  warn(message) {
    console.warn(`[BitNet] ${message}`);
  },
};

export function getBitNetLogger(): BitNetLogger {
  return logger;
}

export function setBitNetLogger(nextLogger: BitNetLogger): void {
  logger = nextLogger;
}

export function normalizeMetrics<T extends { memoryUsageBytes?: number; memoryUsageMB?: number }>(metrics: T): T {
  if (metrics.memoryUsageMB === undefined) {
    return {
      ...metrics,
      memoryUsageMB: (metrics.memoryUsageBytes ?? 0) / 1024 / 1024,
    };
  }
  return metrics;
}
