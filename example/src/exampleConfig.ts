import { Platform } from 'react-native';
import { BitNet, RECOMMENDED_BITNET_MODEL } from '@bitnet/react-native';

export const SYSTEM_PROMPT = 'You are a helpful assistant. Answer directly and keep responses concise.';
export const CONFIGURED_MODEL = RECOMMENDED_BITNET_MODEL;
export const CONFIGURED_MODEL_ID = BitNet.modelId(CONFIGURED_MODEL);

export const WEB_MAX_TOKENS = 128;
export const MOBILE_MAX_TOKENS = 64;
export const WEB_CONTEXT_SIZE = 512;
export const MOBILE_CONTEXT_SIZE = 2048;
export const WEB_THREADS = 1;
export const MOBILE_THREADS = 2;

export const EXAMPLE_CONTEXT_SIZE = Platform.OS === 'web' ? WEB_CONTEXT_SIZE : MOBILE_CONTEXT_SIZE;
export const EXAMPLE_THREADS = Platform.OS === 'web' ? WEB_THREADS : MOBILE_THREADS;
export const EXAMPLE_MAX_TOKENS = Platform.OS === 'web' ? WEB_MAX_TOKENS : MOBILE_MAX_TOKENS;

export function configureExampleBitNet(): void {
  const configureBitNetForExample = BitNet.configure as (config: { performanceAudit?: boolean }) => void;
  configureBitNetForExample({ performanceAudit: true });
}
