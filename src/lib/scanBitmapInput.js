/**
 * 匯入效能：用 ImageBitmap 單次解碼＋縮放，避免先 readAsDataURL 再 JPEG 再給 Worker 二次解碼。
 * 回傳的 bitmap 須由呼叫端 transfer 給 Worker 或手動 close。
 *
 * @param {File | Blob | string} input File／Blob，或 data URL 字串
 * @param {number} maxLongEdge
 * @returns {Promise<{ bitmap: ImageBitmap, width: number, height: number }>}
 */
export async function createScaledScanBitmap(input, maxLongEdge) {
  const edge = Math.max(320, Math.min(4500, Math.round(maxLongEdge || 2000)))

  let bitmap
  if (typeof input === 'string') {
    const res = await fetch(input)
    bitmap = await createImageBitmap(await res.blob())
  } else {
    bitmap = await createImageBitmap(input)
  }

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
