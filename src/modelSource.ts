import type { CachedModel, DownloadSource } from './types';

export type DownloadRequest = {
  id: string;
  url: string;
  fileName: string;
  checksumSha256?: string;
  source?: string;
};

export const RECOMMENDED_BITNET_MODEL: DownloadSource = {
  hf: 'microsoft/BitNet-b1.58-2B-4T-gguf',
  file: 'ggml-model-i2_s.gguf',
  id: 'bitnet-b1.58-2b-i2s',
  checksumSha256: '4221b252fdd5fd25e15847adfeb5ee88886506ba50b8a34548374492884c2162',
};

export function modelIdFromSource(source: DownloadSource): string {
  if ('url' in source) {
    const clean = source.url.split('?')[0] ?? source.url;
    return source.id ?? clean.substring(clean.lastIndexOf('/') + 1);
  }
  return source.id ?? `${source.hf.replace('/', '__')}__${source.file}`;
}

export function toDownloadRequest(source: DownloadSource): DownloadRequest {
  if ('url' in source) {
    const cleanUrl = source.url.split('?')[0] ?? source.url;
    return {
      id: modelIdFromSource(source),
      url: source.url,
      fileName: source.fileName ?? cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1),
      checksumSha256: source.checksumSha256,
    };
  }

  const revision = source.revision ?? 'main';
  return {
    id: modelIdFromSource(source),
    url: `https://huggingface.co/${source.hf}/resolve/${revision}/${source.file}`,
    fileName: source.file,
    checksumSha256: source.checksumSha256,
    source: source.hf,
  };
}

export function downloadRequestMatchesCachedModel(cached: CachedModel, request: DownloadRequest): boolean {
  const expectedSource = request.source ?? request.url;
  const expectedChecksum = request.checksumSha256?.toLowerCase();
  const cachedChecksum = cached.checksumSha256?.toLowerCase();

  if (cached.source !== expectedSource || cached.fileName !== request.fileName) {
    return false;
  }
  return !expectedChecksum || cachedChecksum === expectedChecksum;
}
