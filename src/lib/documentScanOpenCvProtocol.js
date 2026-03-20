/**
 * 主執行緒與 documentScanOpenCv.worker 共用，避免循環依賴。
 */
export const WORKER_MSG = {
  warmup: 'warmup',
  scanBitmap: 'scanBitmap',
  scanDataUrl: 'scanDataUrl',
}
