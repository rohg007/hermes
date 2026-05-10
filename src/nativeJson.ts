import { BitNetError } from './errors';

export function parseNativeJson<T>(payload: string, label: string): T {
  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new BitNetError(
      'BITNET_UNKNOWN',
      `Native BitNet returned invalid JSON for ${label}.`,
      { cause: error }
    );
  }
}

export function stringifyNativeJson(value: unknown): string {
  return JSON.stringify(value);
}
