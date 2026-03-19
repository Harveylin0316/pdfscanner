/**
 * 主執行緒橋接：OpenCV 掃描在 Web Worker 跑，頁面可捲動／點擊不中斷。
 * Worker 不可用時回傳 null（改走簡易裁切 + 文件加強）。
 */

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

/** 進入頁面後背景載入 Worker + OpenCV */
export function warmUpOpenCv() {
  const w = getWorker()
  if (!w) return
  w.postMessage({ type: 'warmup', id: -1 })
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
