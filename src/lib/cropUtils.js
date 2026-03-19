/**
 * 依正規化裁切框（0–1）從圖片產出 JPEG data URL（供裁切 modal 與測試使用）。
 */
function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (url.startsWith('http://') || url.startsWith('https://')) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('圖片載入失敗'))
    img.src = url
  })
}

const MIN_FRAC = 0.06

export function clampCropNorm(c) {
  let { x, y, w, h } = c
  w = Math.max(MIN_FRAC, Math.min(1, w))
  h = Math.max(MIN_FRAC, Math.min(1, h))
  x = Math.max(0, Math.min(1 - w, x))
  y = Math.max(0, Math.min(1 - h, y))
  return { x, y, w, h }
}

export async function cropDataUrlFromNormalized(imageUrl, norm, jpegQuality = 0.92) {
  const img = await loadImageElement(imageUrl)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  const { x, y, w, h } = clampCropNorm(norm)
  const sx = x * nw
  const sy = y * nh
  const sw = w * nw
  const sh = h * nh
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw))
  canvas.height = Math.max(1, Math.round(sh))
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', jpegQuality)
}
