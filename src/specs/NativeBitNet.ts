import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  getConstants(): {
    nativeVersion: string;
    maxConcurrencyPerModel: number;
  };

  getRuntimeCapabilities(): Promise<string>;

  loadModel(modelPath: string, optionsJson: string): Promise<string>;
  unloadModel(modelHandle: string): Promise<void>;

  startGeneration(modelHandle: string, paramsJson: string): Promise<string>;
  nextTokenBatch(
    generationHandle: string,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string>;
  cancelGeneration(generationHandle: string): Promise<void>;

  downloadModel(requestJson: string): Promise<string>;
  getDownloadProgress(jobHandle: string): Promise<string>;
  awaitDownload(jobHandle: string): Promise<string>;
  cancelDownload(jobHandle: string): Promise<void>;

  listModels(): Promise<string>;
  deleteModel(modelId: string): Promise<boolean>;
  getDiskUsage(): Promise<number>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('BitNet');
