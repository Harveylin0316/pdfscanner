/**
 * OpenCV 掃描於 Web Worker：像素讀取（getImageData）僅在此執行緒，不阻塞主頁面。
 */
import {
  runDocumentScanPipeline,
  runDocumentScanPipelineFromRgbaMat,
} from './documentScanOpenCvCore.js'
import { SCAN_MODE, WORKER_MSG } from './documentScanOpenCvProtocol.js'

const OPENCV_INIT_TIMEOUT_MS = 90_000

let opencvLoadPromise = null

async function loadOpenCvOnce() {
  const cvModule = await import('@techstark/opencv-js')
  let m = cvModule.default ?? cvModule
  if (m instanceof Promise) {
    m = await m
  }

  const waitRuntime = new Promise((resolve) => {
    const finish = () => resolve()

    if (m.runtimeInitialized === true || m.calledRun === true) {
      finish()
      return
    }

    const prev = m.onRuntimeInitialized
    m.onRuntimeInitialized = () => {
      try {
        if (typeof prev === 'function') prev()
      } catch {
        /* ignore */
      }
      finish()
    }

    queueMicrotask(() => {
      if (m.runtimeInitialized === true || m.calledRun === true) {
        finish()
      }
    })
  })

  await Promise.race([
    waitRuntime,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('OpenCV init timeout')), OPENCV_INIT_TIMEOUT_MS)
    }),
  ])

  return m
}

async function getCv() {
  if (!opencvLoadPromise) {
    opencvLoadPromise = loadOpenCvOnce()
  }
  try {
    return await opencvLoadPromise
  } catch {
    opencvLoadPromise = null
    return null
  }
}

/**
 * Transfer 進來的 ImageBitmap → OffscreenCanvas → getImageData → OpenCV Mat（CV_8UC4）。
 * 結束後關閉 bitmap；失敗亦關閉。
 * @param {*} cv OpenCV 實例
 * @param {ImageBitmap} bitmap
 */
function imageBitmapToRgbaSrcMat(cv, bitmap) {
  const w = bitmap.width
  const h = bitmap.height
  if (!w || !h) {
    try {
      bitmap.close()
    } catch {
      /* ignore */
    }
    return null
  }

  const oc = new OffscreenCanvas(w, h)
  let ctx
  try {
    ctx = oc.getContext('2d', { willReadFrequently: true })
  } catch {
    ctx = oc.getContext('2d')
  }
  if (!ctx) {
    try {
      bitmap.close()
    } catch {
      /* ignore */
    }
    return null
  }

  try {
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, w, h)
    try {
      bitmap.close()
    } catch {
      /* ignore */
    }
    return cv.matFromImageData(imageData)
  } catch {
    try {
      bitmap.close()
    } catch {
      /* ignore */
    }
    return null
  }
}

function pipelineOptionsFromScanMode(scanMode) {
  return {
    scanMode: scanMode === SCAN_MODE.full ? SCAN_MODE.full : SCAN_MODE.instant,
  }
}

/** 串行處理，避免同時兩個 OpenCV job 打爆 WASM */
const inbox = []
let drainRunning = false

async function drainInbox() {
  if (drainRunning) return
  drainRunning = true
  try {
    while (inbox.length > 0) {
      const event = inbox.shift()
      const {
        type,
        id,
        dataUrl,
        jpegQuality,
        maxDecodeLongEdge,
        knownDecodeWH,
        bitmap,
        scanMode: scanModeRaw,
      } = event.data || {}
      const pipelineOpts = pipelineOptionsFromScanMode(scanModeRaw)

      if (type === WORKER_MSG.warmup) {
        try {
          await getCv()
          self.postMessage({ id, ok: true })
        } catch {
          self.postMessage({ id, ok: false })
        }
        continue
      }

      try {
        const cv = await getCv()
        if (!cv) {
          if (bitmap instanceof ImageBitmap) {
            try {
              bitmap.close()
            } catch {
              /* ignore */
            }
          }
          self.postMessage({ id, result: null })
          continue
        }

        if (type === WORKER_MSG.scanBitmap && bitmap instanceof ImageBitmap) {
          try {
            const src = imageBitmapToRgbaSrcMat(cv, bitmap)
            if (!src) {
              self.postMessage({ id, result: null })
              continue
            }
            const result = await runDocumentScanPipelineFromRgbaMat(
              cv,
              src,
              jpegQuality ?? 0.92,
              pipelineOpts,
            )
            self.postMessage({ id, result })
          } catch (err) {
            try {
              if (bitmap instanceof ImageBitmap) bitmap.close()
            } catch {
              /* ignore */
            }
            self.postMessage({ id, result: null, error: String(err?.message || err) })
          }
          continue
        }

        /** 僅在走 dataUrl 管線時關閉誤傳的 bitmap，避免吃掉「舊版無 type」訊息 */
        if (type === WORKER_MSG.scanDataUrl && bitmap instanceof ImageBitmap) {
          try {
            bitmap.close()
          } catch {
            /* ignore */
          }
        }

        if (type === WORKER_MSG.scanDataUrl && typeof dataUrl === 'string') {
          const result = await runDocumentScanPipeline(
            cv,
            dataUrl,
            jpegQuality ?? 0.92,
            maxDecodeLongEdge,
            knownDecodeWH,
            pipelineOpts,
          )
          self.postMessage({ id, result })
          continue
        }

        /** 相容舊訊息：未帶 type 時依欄位推斷 */
        if (bitmap instanceof ImageBitmap) {
          try {
            const src = imageBitmapToRgbaSrcMat(cv, bitmap)
            if (!src) {
              self.postMessage({ id, result: null })
              continue
            }
            const result = await runDocumentScanPipelineFromRgbaMat(
              cv,
              src,
              jpegQuality ?? 0.92,
              pipelineOpts,
            )
            self.postMessage({ id, result })
          } catch (err) {
            self.postMessage({ id, result: null, error: String(err?.message || err) })
          }
          continue
        }

        if (typeof dataUrl === 'string') {
          const result = await runDocumentScanPipeline(
            cv,
            dataUrl,
            jpegQuality ?? 0.92,
            maxDecodeLongEdge,
            knownDecodeWH,
            pipelineOpts,
          )
          self.postMessage({ id, result })
          continue
        }

        self.postMessage({ id, result: null })
      } catch (err) {
        self.postMessage({ id, result: null, error: String(err?.message || err) })
      }
    }
  } finally {
    drainRunning = false
    if (inbox.length > 0) {
      void drainInbox()
    }
  }
}

self.onmessage = (event) => {
  inbox.push(event)
  void drainInbox()
}
