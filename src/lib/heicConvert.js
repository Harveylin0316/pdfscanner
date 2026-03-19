/**
 * HEIC → JPEG (data URL)，優先 Web Worker（heic-to/next），並在解碼後立刻縮圖以降低記憶體與時間。
 */

function bitmapToScaledJpegDataUrl(bitmap, targetMaxEdge) {
  const maxSide = Math.max(bitmap.width, bitmap.height, 1)
  const scale = Math.min(1, targetMaxEdge / maxSide)
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, w, h)
  if (typeof bitmap.close === 'function') {
    bitmap.close()
  }
  // 解碼後先壓成略低品質 JPEG，後續還會經 compressImage／輸出管線
  return canvas.toDataURL('image/jpeg', 0.88)
}

/**
 * @param {File} file
 * @param {number} targetMaxEdge 長邊上限（與工具頁「圖片長邊上限」一致）
 */
export async function convertHeicToJpegDataUrl(file, targetMaxEdge = 2000) {
  const edge = Math.max(800, Math.min(4000, targetMaxEdge || 2000))

  // 1) Worker 版：不阻塞主執行緒，體感較不會「當掉」
  try {
    const { heicTo } = await import('heic-to/next')
    const bitmap = await heicTo({ blob: file, type: 'bitmap' })
    return bitmapToScaledJpegDataUrl(bitmap, edge)
  } catch {
    /* continue */
  }

  // 2) 主執行緒 JPEG blob → Bitmap → 縮圖（避免超大中間檔）
  try {
    const { heicTo } = await import('heic-to')
    const blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.82 })
    if (!blob || blob.size === 0) throw new Error('empty')
    const bitmap = await createImageBitmap(blob)
    return bitmapToScaledJpegDataUrl(bitmap, edge)
  } catch {
    /* continue */
  }

  // 3) heic2any
  try {
    const { default: heic2any } = await import('heic2any')
    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.82,
    })
    const blob = Array.isArray(converted) ? converted[0] : converted
    const bitmap = await createImageBitmap(blob)
    return bitmapToScaledJpegDataUrl(bitmap, edge)
  } catch {
    /* continue */
  }

  // 4) 少數環境可原生解 HEIC
  try {
    const bitmap = await createImageBitmap(file)
    return bitmapToScaledJpegDataUrl(bitmap, edge)
  } catch {
    /* continue */
  }

  throw new Error(
    `HEIC 無法解碼：${file.name}。建議到 iPhone「設定 → 相機 → 格式」改為「最佳相容性」，或先用「照片」分享成 JPG 再上傳。`,
  )
}
