/**
 * 主執行緒橋接：OpenCV 掃描在 Web Worker 跑，頁面可捲動／點擊不中斷。
 * Worker 不可用時回傳 null（改走簡易裁切 + 文件加強）。
 */

import { WORKER_MSG } from './documentScanOpenCvProtocol.js'

const WORKER_JOB_TIMEOUT_MS = 90_000

let workerRef = null
let workerFailed = false
let jobSeq = 0
const pending = new Map()

function attachWorkerHandlers(w) {
  w.onmessage = (event) => {
    const { id, result } = event.data || {}
    const job = pending.get(id)
    if (!job) return
    pending.delete(id)
    clearTimeout(job.timer)
    job.resolve(result ?? null)
  }

  w.onmessageerror = () => {
    for (const [, job] of pending) {
      clearTimeout(job.timer)
      job.resolve(null)
    }
    pending.clear()
  }

  w.onerror = () => {
    for (const [, job] of pending) {
      clearTimeout(job.timer)
      job.resolve(null)
    }
    pending.clear()
    try {
      w.terminate()
    } catch {
      /* ignore */
    }
    workerRef = null
    workerFailed = true
  }
}

function getWorker() {
  if (workerFailed) return null
  if (workerRef) return workerRef
  if (typeof Worker === 'undefined') {
    workerFailed = true
    return null
  }
  try {
    const w = new Worker(new URL('./documentScanOpenCv.worker.js', import.meta.url), { type: 'module' })
    attachWorkerHandlers(w)
    workerRef = w
    return w
  } catch {
    workerFailed = true
    return null
  }
}

export { WORKER_MSG } from './documentScanOpenCvProtocol.js'

/** 進入頁面後背景載入 Worker + OpenCV */
export function warmUpOpenCv() {
  const w = getWorker()
  if (!w) return
  w.postMessage({ type: WORKER_MSG.warmup, id: -1 })
}

/**
 * @param {string} dataUrl
 * @param {number} jpegQuality
 * @param {number} [maxDecodeLongEdge] 與主執行緒壓縮長邊一致，避免先放大再被 Worker 縮回
 * @param {{ width: number, height: number } | null} [knownDecodeWH] 可加速 Worker 內解碼（略過全圖 probe）
 * @returns {Promise<string|null>}
 */
export function applyOpenCvDocumentScan(
  dataUrl,
  jpegQuality = 0.92,
  maxDecodeLongEdge,
  knownDecodeWH = null,
) {
  const w = getWorker()
  if (!w) {
    return Promise.resolve(null)
  }

  const edge =
    typeof maxDecodeLongEdge === 'number' && maxDecodeLongEdge > 0
      ? Math.min(4500, Math.max(640, Math.round(maxDecodeLongEdge)))
      : 2000

  return new Promise((resolve) => {
    const id = jobSeq++
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve(null)
      }
    }, WORKER_JOB_TIMEOUT_MS)

    pending.set(id, { resolve, timer })
    try {
      w.postMessage({
        type: WORKER_MSG.scanDataUrl,
        id,
        dataUrl,
        jpegQuality,
        maxDecodeLongEdge: edge,
        knownDecodeWH:
          knownDecodeWH &&
          knownDecodeWH.width > 0 &&
          knownDecodeWH.height > 0
            ? { width: knownDecodeWH.width, height: knownDecodeWH.height }
            : undefined,
      })
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      resolve(null)
    }
  })
}

/**
 * 將已縮放之 ImageBitmap 以 Transferable 交給 Worker；主執行緒不做 getImageData／matFromImageData。
 * Worker 內以 OffscreenCanvas 繪製後再 getImageData → OpenCV。失敗時關閉 bitmap；成功由 Worker 關閉。
 * @param {ImageBitmap} bitmap
 * @param {number} [jpegQuality]
 * @returns {Promise<string|null>}
 */
export function applyOpenCvDocumentScanFromBitmap(bitmap, jpegQuality = 0.92) {
  const w = getWorker()
  if (!bitmap) {
    return Promise.resolve(null)
  }
  if (!w) {
    try {
      bitmap.close()
    } catch {
      /* ignore */
    }
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const id = jobSeq++
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        // bitmap 已 transfer 至 Worker，主執行緒不可再 close
        resolve(null)
      }
    }, WORKER_JOB_TIMEOUT_MS)

    pending.set(id, { resolve, timer })
    try {
      w.postMessage({ type: WORKER_MSG.scanBitmap, id, bitmap, jpegQuality }, [bitmap])
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      try {
        bitmap.close()
      } catch {
        /* ignore */
      }
      resolve(null)
    }
  })
}
