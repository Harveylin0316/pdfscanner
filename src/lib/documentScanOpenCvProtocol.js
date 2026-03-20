/**
 * 主執行緒與 documentScanOpenCv.worker 共用，避免循環依賴。
 */
export const WORKER_MSG = {
  warmup: 'warmup',
  scanBitmap: 'scanBitmap',
  scanDataUrl: 'scanDataUrl',
}

/** instant：裁切後只縮圖+JPEG（略過偵測／透視／Lab，可快很多）。full：完整 OpenCV 管線 */
export const SCAN_MODE = {
  instant: 'instant',
  full: 'full',
}
