import { Platform } from 'react-native';
import type { Spec } from '../specs/NativeBitNet';
import { WebBitNetModule } from '../web/WebBitNetModule';

declare const require: (id: string) => { default: Spec };

const NativeBitNet: Spec =
  Platform.OS === 'web' ? (WebBitNetModule as unknown as Spec) : require('../specs/NativeBitNet').default;

export default NativeBitNet;
