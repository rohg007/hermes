export type BitNetErrorCode =
  | 'BITNET_NATIVE_UNAVAILABLE'
  | 'BITNET_MODEL_NOT_FOUND'
  | 'BITNET_MODEL_INCOMPATIBLE'
  | 'BITNET_RUNTIME_UNSUPPORTED'
  | 'BITNET_RUNTIME_UNAVAILABLE'
  | 'BITNET_RUNTIME_ERROR'
  | 'BITNET_INFERENCE_BUSY'
  | 'BITNET_INFERENCE_CANCELLED'
  | 'BITNET_DOWNLOAD_FAILED'
  | 'BITNET_DOWNLOAD_CANCELLED'
  | 'BITNET_CHECKSUM_MISMATCH'
  | 'BITNET_INVALID_ARGUMENT'
  | 'BITNET_UNKNOWN';

export class BitNetError extends Error {
  readonly code: BitNetErrorCode;
  readonly nativeCode?: string;
  readonly cause?: unknown;

  constructor(code: BitNetErrorCode, message: string, options?: { nativeCode?: string; cause?: unknown }) {
    super(message);
    this.name = 'BitNetError';
    this.code = code;
    this.nativeCode = options?.nativeCode;
    this.cause = options?.cause;
  }
}

export class ModelNotFoundError extends BitNetError {
  constructor(model: string) {
    super(
      'BITNET_MODEL_NOT_FOUND',
      `Model not found: ${model}. Use BitNet.load() for the recommended model, or run BitNet.downloadModel(...) before loading a custom model.`
    );
    this.name = 'ModelNotFoundError';
  }
}

export class ModelIncompatibleError extends BitNetError {
  constructor(message: string) {
    super('BITNET_MODEL_INCOMPATIBLE', message);
    this.name = 'ModelIncompatibleError';
  }
}

export class RuntimeUnavailableError extends BitNetError {
  constructor(runtime: string, reason?: string) {
    super(
      'BITNET_RUNTIME_UNAVAILABLE',
      `BitNet runtime "${runtime}" is not available${reason ? `: ${reason}` : '.'}`
    );
    this.name = 'RuntimeUnavailableError';
  }
}

export class NativeUnavailableError extends BitNetError {
  constructor(reason?: string) {
    const setupFix = 'Run `yarn bitnet:init`, then rebuild the app.';
    super(
      'BITNET_NATIVE_UNAVAILABLE',
      reason
        ? `BitNet native backend is unavailable: ${reason}. ${setupFix}`
        : `BitNet native backend is unavailable. ${setupFix}`
    );
    this.name = 'NativeUnavailableError';
  }
}

export class UnsupportedRuntimeError extends BitNetError {
  constructor(runtime: string, reason?: string) {
    super(
      'BITNET_RUNTIME_UNSUPPORTED',
      `BitNet runtime "${runtime}" is not supported${reason ? `: ${reason}` : '.'}`
    );
    this.name = 'UnsupportedRuntimeError';
  }
}

export class InferenceBusyError extends BitNetError {
  constructor() {
    super(
      'BITNET_INFERENCE_BUSY',
      'This BitNet model is already running inference. Wait for the current generation to finish or cancel it.'
    );
    this.name = 'InferenceBusyError';
  }
}

export class InferenceCancelledError extends BitNetError {
  constructor() {
    super('BITNET_INFERENCE_CANCELLED', 'BitNet inference was cancelled.');
    this.name = 'InferenceCancelledError';
  }
}

export class DownloadError extends BitNetError {
  constructor(message: string, cause?: unknown) {
    super('BITNET_DOWNLOAD_FAILED', message, { cause });
    this.name = 'DownloadError';
  }
}

export class DownloadCancelledError extends BitNetError {
  constructor(modelId?: string) {
    super(
      'BITNET_DOWNLOAD_CANCELLED',
      `BitNet model download was cancelled${modelId ? ` for "${modelId}"` : ''}.`
    );
    this.name = 'DownloadCancelledError';
  }
}

export class ChecksumMismatchError extends BitNetError {
  constructor(modelId: string) {
    super('BITNET_CHECKSUM_MISMATCH', `Checksum validation failed for model "${modelId}".`);
    this.name = 'ChecksumMismatchError';
  }
}

const NATIVE_ERROR_PREFIX = /^(?:Error:\s*)?(?:BITNET_[A-Z_]+|BITNET_NATIVE)\s*:\s*/;

function stripNativeErrorPrefixes(message: string): string {
  let clean = message.trim();
  for (let index = 0; index < 4; index += 1) {
    const next = clean.replace(NATIVE_ERROR_PREFIX, '').trim();
    if (next === clean) {
      return clean;
    }
    clean = next;
  }
  return clean;
}

export function fromNativeError(error: unknown): BitNetError {
  if (error instanceof BitNetError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const cleanMessage = stripNativeErrorPrefixes(message);
  if (message.includes('BITNET_NATIVE_UNAVAILABLE')) {
    return new NativeUnavailableError(cleanMessage);
  }
  if (message.includes('BITNET_INFERENCE_BUSY')) {
    return new InferenceBusyError();
  }
  if (message.includes('BITNET_RUNTIME_UNSUPPORTED')) {
    return new UnsupportedRuntimeError(message.toLowerCase().includes('gpu') ? 'gpu' : 'requested', cleanMessage);
  }
  if (message.includes('BITNET_RUNTIME_UNAVAILABLE')) {
    return new RuntimeUnavailableError(message.toLowerCase().includes('gpu') ? 'gpu' : 'requested', cleanMessage);
  }
  if (message.includes('BITNET_RUNTIME_ERROR') || message.includes('BITNET_INTERNAL')) {
    return new BitNetError('BITNET_RUNTIME_ERROR', cleanMessage, { cause: error });
  }
  if (message.includes('BITNET_MODEL_NOT_FOUND')) {
    const modelMessage =
      cleanMessage.startsWith('/') || cleanMessage.startsWith('file://')
        ? `Model not found at ${cleanMessage}. Download the model again or pass a cached model id from BitNet.downloadModel().`
        : cleanMessage;
    return new BitNetError('BITNET_MODEL_NOT_FOUND', modelMessage, { cause: error });
  }
  if (message.includes('BITNET_MODEL_INCOMPATIBLE')) {
    return new ModelIncompatibleError(cleanMessage);
  }
  if (message.includes('BITNET_INFERENCE_CANCELLED')) {
    return new InferenceCancelledError();
  }
  if (message.includes('BITNET_DOWNLOAD_FAILED')) {
    return new DownloadError(cleanMessage, error);
  }
  if (message.includes('BITNET_DOWNLOAD_CANCELLED')) {
    return new DownloadCancelledError();
  }
  if (message.includes('BITNET_CHECKSUM_MISMATCH')) {
    return new BitNetError('BITNET_CHECKSUM_MISMATCH', cleanMessage, { cause: error });
  }
  if (message.includes('BITNET_INVALID_ARGUMENT')) {
    return new BitNetError('BITNET_INVALID_ARGUMENT', cleanMessage, { cause: error });
  }

  return new BitNetError('BITNET_UNKNOWN', cleanMessage, { cause: error });
}
