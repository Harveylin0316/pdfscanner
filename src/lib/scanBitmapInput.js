/**
 * 匯入效能：多路徑降採樣後再送 OpenCV Worker。
 * 1) 檔頭讀尺寸 + createImageBitmap resize
 * 2) ImageDecoder（AVIF／部分 WebP 等，瀏覽器支援時）desiredWidth/Height
 * 3) 完整解碼後 canvas 縮圖（最後備援）
 */

import {
  probeImageDimensionsFromBlob,
  sniffImageMimeTypeFromBlob,
} from './imageDimensionsProbe.js'

/**
 * @param {Blob} blob
 * @param {number} edge
 * @param {string} [mimeHint] File.type 或 data URL 的 mime
 * @returns {Promise<{ bitmap: ImageBitmap, width: number, height: number } | null>}
 */
async function tryImageDecoderScaledBitmap(blob, edge, mimeHint) {
  if (typeof ImageDecoder === 'undefined') return null

  let type = (mimeHint || '').trim()
  if (type && typeof ImageDecoder.isTypeSupported === 'function' && !ImageDecoder.isTypeSupported(type)) {
    type = ''
  }
  if (!type) {
    type = await sniffImageMimeTypeFromBlob(blob)
  }
  if (!type || (typeof ImageDecoder.isTypeSupported === 'function' && !ImageDecoder.isTypeSupported(type))) {
    return null
  }

  let decoder
  try {
    decoder = new ImageDecoder({
      data: blob.stream(),
      type,
    })
    if (decoder.tracks?.ready) {
      await decoder.tracks.ready
    }
    if (decoder.completed && typeof decoder.completed.then === 'function') {
      await decoder.completed
    }
    const track = decoder.tracks?.selectedTrack
    if (!track) return null
    const nw = track.displayWidth
    const nh = track.displayHeight
    if (!nw || !nh) return null

    const scale = Math.min(1, edge / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * scale))
    const h = Math.max(1, Math.round(nh * scale))

    const result = await decoder.decode({
      desiredWidth: w,
      desiredHeight: h,
    })
    const frame = result.image
    let bitmap = await createImageBitmap(frame)
    try {
      frame.close?.()
    } catch {
      /* ignore */
    }

    const long = Math.max(bitmap.width, bitmap.height)
    if (long > edge * 1.08) {
      const s = edge / long
      const tw = Math.max(1, Math.round(bitmap.width * s))
      const th = Math.max(1, Math.round(bitmap.height * s))
      if (typeof OffscreenCanvas !== 'undefined') {
        const oc = new OffscreenCanvas(tw, th)
        oc.getContext('2d').drawImage(bitmap, 0, 0, tw, th)
        const next = await createImageBitmap(oc)
        bitmap.close()
        bitmap = next
      } else {
        const canvas = document.createElement('canvas')
        canvas.width = tw
        canvas.height = th
        canvas.getContext('2d').drawImage(bitmap, 0, 0, tw, th)
        const next = await createImageBitmap(canvas)
        bitmap.close()
        bitmap = next
      }
      return { bitmap, width: tw, height: th }
    }

    return { bitmap, width: bitmap.width, height: bitmap.height }
  } catch {
    return null
  } finally {
    try {
      decoder?.close?.()
    } catch {
      /* ignore */
    }
  }
}

function mimeFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return ''
  const m = dataUrl.match(/^data:([^;,]+)/i)
  return m ? m[1].trim() : ''
}

/**
 * @param {File | Blob | string} input
 * @param {number} maxLongEdge
 * @param {string} [mimeHint] 建議傳 File.type；data URL 可省略（自動從字串解析）
 * @returns {Promise<{ bitmap: ImageBitmap, width: number, height: number }>}
 */
export async function createScaledScanBitmap(input, maxLongEdge, mimeHint = '') {
  const edge = Math.max(320, Math.min(4500, Math.round(maxLongEdge || 2000)))

  let blob
  let resolvedMime = (mimeHint || '').trim()

  if (typeof input === 'string') {
    const res = await fetch(input)
    blob = await res.blob()
    if (!resolvedMime) {
      resolvedMime = mimeFromDataUrl(input) || blob.type || ''
    }
  } else {
    blob = input
    if (!resolvedMime && typeof input.type === 'string') {
      resolvedMime = input.type
    }
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
        /* continue */
      }
    } else {
      try {
        const bitmap = await createImageBitmap(blob)
        return { bitmap, width: w, height: h }
      } catch {
        /* continue */
      }
    }
  }

  const dec = await tryImageDecoderScaledBitmap(blob, edge, resolvedMime)
  if (dec) return dec

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
