import type { DownloadProgress } from './types';

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

export function downloadProgressPercent(progress: DownloadProgress): number {
  const total = progress.totalBytes ?? 0;
  if (total <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((progress.receivedBytes / total) * 100));
}

export function formatDownloadProgress(progress: DownloadProgress): string {
  const total = progress.totalBytes ?? 0;
  const percent = downloadProgressPercent(progress);
  const bytes =
    total > 0
      ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(total)}`
      : formatBytes(progress.receivedBytes);

  switch (progress.status) {
    case 'queued':
      return `Queued download for ${progress.modelId}...`;
    case 'downloading':
      return `Downloading ${progress.modelId}: ${total > 0 ? `${percent}% · ` : ''}${bytes}`;
    case 'validating':
      return `Validating ${progress.modelId}...`;
    case 'completed':
      return `Cached model ready: ${progress.modelId}`;
    case 'cancelled':
      return `Download cancelled for ${progress.modelId}.`;
    case 'failed':
      return progress.error ?? `Download failed for ${progress.modelId}.`;
    default:
      return `Preparing ${progress.modelId}...`;
  }
}
