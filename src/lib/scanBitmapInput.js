/**
 * 匯入效能：ImageBitmap 送 OpenCV Worker。
 * 對 PNG／JPEG 等可先由檔頭得知像素尺寸，再用 createImageBitmap 的 resize 選項解碼，
 * 避免「1.x MB 但八千萬像素」類大圖在主執行緒全尺寸解碼卡死。
 */

import { probeImageDimensionsFromBlob } from './imageDimensionsProbe.js'

/**
 * @param {File | Blob | string} input File／Blob，或 data URL 字串
 * @param {number} maxLongEdge
 * @returns {Promise<{ bitmap: ImageBitmap, width: number, height: number }>}
 */
export async function createScaledScanBitmap(input, maxLongEdge) {
  const edge = Math.max(320, Math.min(4500, Math.round(maxLongEdge || 2000)))

  let blob
  if (typeof input === 'string') {
    const res = await fetch(input)
    blob = await res.blob()
  } else {
    blob = input
  }

  const probed = await probeImageDimensionsFromBlob(blob)
  if (probed && probed.w > 0 && probed.h > 0) {
    const nw = probed.w
    const nh = probed.h
    const scale = Math.min(1, edge / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * scale))
    const h = Math.max(1, Math.round(nh * scale))

    if (scale < 1) {
      try {
        const bitmap = await createImageBitmap(blob, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'high',
        })
        return { bitmap, width: w, height: h }
      } catch {
        /* 不支援 resize 選項時改走下方完整解碼 */
      }
    } else {
      try {
        const bitmap = await createImageBitmap(blob)
        return { bitmap, width: w, height: h }
      } catch {
        /* fall through */
      }
    }
  }

  let bitmap = await createImageBitmap(blob)

  try {
    const nw = bitmap.width
    const nh = bitmap.height
    if (!nw || !nh) {
      throw new Error('圖片尺寸無效')
    }
    const scale = Math.min(1, edge / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * scale))
    const h = Math.max(1, Math.round(nh * scale))

    if (scale >= 1) {
      return { bitmap, width: w, height: h }
    }

    if (typeof OffscreenCanvas !== 'undefined') {
      const oc = new OffscreenCanvas(w, h)
      const ctx = oc.getContext('2d')
      ctx.drawImage(bitmap, 0, 0, w, h)
      const scaled = await createImageBitmap(oc)
      bitmap.close()
      return { bitmap: scaled, width: w, height: h }
    }

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
    const scaled = await createImageBitmap(canvas)
    bitmap.close()
    return { bitmap: scaled, width: w, height: h }
  } catch (err) {
    try {
      bitmap.close()
    } catch {
      /* ignore */
    }
    throw err
  }
}
