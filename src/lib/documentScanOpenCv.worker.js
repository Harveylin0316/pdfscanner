/**
 * OpenCV 掃描於 Web Worker 執行，避免 WASM 卡住主執行緒（整頁凍結）
 */
import {
  runDocumentScanPipeline,
  runDocumentScanPipelineFromRgbaMat,
} from './documentScanOpenCvCore.js'

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

/** 串行處理，避免同時兩個 OpenCV job 打爆 WASM */
const inbox = []
let drainRunning = false

async function drainInbox() {
  if (drainRunning) return
  drainRunning = true
  try {
    while (inbox.length > 0) {
      const event = inbox.shift()
      const { id, type, dataUrl, jpegQuality, maxDecodeLongEdge, knownDecodeWH, bitmap } =
        event.data || {}

      if (type === 'warmup') {
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
          self.postMessage({ id, result: null })
          continue
        }

        if (bitmap instanceof ImageBitmap) {
          let bmp = bitmap
          try {
            const w = bmp.width
            const h = bmp.height
            if (!w || !h) {
              try {
                bmp.close()
              } catch {
                /* ignore */
              }
              self.postMessage({ id, result: null })
              continue
            }
            const oc = new OffscreenCanvas(w, h)
            const ctx = oc.getContext('2d')
            ctx.drawImage(bmp, 0, 0)
            bmp.close()
            bmp = null
            const imageData = ctx.getImageData(0, 0, w, h)
            const src = cv.matFromImageData(imageData)
            const result = await runDocumentScanPipelineFromRgbaMat(cv, src, jpegQuality ?? 0.92)
            self.postMessage({ id, result })
          } catch (err) {
            try {
              if (bmp) bmp.close()
            } catch {
              /* ignore */
            }
            self.postMessage({ id, result: null, error: String(err?.message || err) })
          }
          continue
        }

        const result = await runDocumentScanPipeline(
          cv,
          dataUrl,
          jpegQuality ?? 0.92,
          maxDecodeLongEdge,
          knownDecodeWH,
        )
        self.postMessage({ id, result })
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
