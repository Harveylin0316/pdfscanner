/**
 * Client-side helpers to move casual photos closer to "scan-like" output.
 * For production-grade deskew + perspective + ML crop, see project docs or OpenCV.js.
 */

function loadImageToCanvas(dataUrl, maxEdge = 4096) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      const scale = Math.max(width, height) > maxEdge ? maxEdge / Math.max(width, height) : 1
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, width, height)
      resolve({ canvas, ctx, width, height })
    }
    img.onerror = () => reject(new Error('圖片載入失敗'))
    img.src = dataUrl
  })
}

function canvasToJpegDataUrl(canvas, quality = 0.92) {
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * Boost contrast / clarity similar to a quick "document" filter.
 */
export async function enhanceDocumentScan(dataUrl, quality = 0.92) {
  const { canvas, width, height } = await loadImageToCanvas(dataUrl)
  const temp = document.createElement('canvas')
  temp.width = width
  temp.height = height
  const tctx = temp.getContext('2d')
  tctx.filter = 'contrast(1.18) brightness(1.04) saturate(0.85)'
  tctx.drawImage(canvas, 0, 0)
  tctx.filter = 'none'
  return canvasToJpegDataUrl(temp, quality)
}

/**
 * OpenCV 失敗時：較強的「掃描感」濾鏡（淨白紙張、字更黑）。
 */
export async function enhanceDocumentScanAggressive(dataUrl, quality = 0.92, maxEdge = 2200) {
  const { canvas, width, height } = await loadImageToCanvas(dataUrl, maxEdge)
  const temp = document.createElement('canvas')
  temp.width = width
  temp.height = height
  const tctx = temp.getContext('2d')
  /** 接近掃描器：對比略強、紙偏白、彩度收斂 */
  tctx.filter = 'contrast(1.34) brightness(1.09) saturate(0.7)'
  tctx.drawImage(canvas, 0, 0)
  tctx.filter = 'none'
  return canvasToJpegDataUrl(temp, quality)
}

/**
 * 透視校正後色階（主執行緒版）：不放大回原始畫素，避免大圖 toDataURL 卡死。
 * OpenCV 成功路徑已改在 Worker 內處理；此函式保留供其他備援流程使用。
 */
export async function polishScannedDocument(dataUrl, quality = 0.93, maxWorkEdge = 1800) {
  const img = await loadImageNatural(dataUrl)
  const natW = img.naturalWidth
  const natH = img.naturalHeight
  if (!natW || !natH) return dataUrl

  const scale = Math.max(natW, natH) > maxWorkEdge ? maxWorkEdge / Math.max(natW, natH) : 1
  const w = Math.max(1, Math.round(natW * scale))
  const h = Math.max(1, Math.round(natH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)

  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData
  const total = w * h
  const sampleStep = Math.max(1, Math.ceil(total / 80000))
  const samples = []
  for (let j = 0; j < total; j += sampleStep) {
    const i = j * 4
    samples.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
  }
  samples.sort((a, b) => a - b)
  const lo = samples[Math.max(0, Math.floor(samples.length * 0.05))] ?? 0
  const hi = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.985))] ?? 255
  const range = Math.max(22, hi - lo)
  const mul = 255 / range

  for (let i = 0; i < data.length; i += 4) {
    const y = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    const y2 = Math.min(255, Math.max(0, (y - lo) * mul))
    const k = y > 2 ? y2 / y : 1
    data[i] = Math.min(255, Math.round(data[i] * k))
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * k))
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * k))
  }

  ctx.putImageData(imageData, 0, 0)
  return canvasToJpegDataUrl(canvas, quality)
}

function loadImageNatural(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('圖片載入失敗'))
    img.src = dataUrl
  })
}

/**
 * Rough auto-crop when the paper is brighter / different from uniform desk background.
 * Works best: white paper on darker desk, corners show background. Not a replacement for ML / OpenCV.
 */
export async function autoCropByCornerBackground(dataUrl, quality = 0.92) {
  const img = await loadImageNatural(dataUrl)
  const natW = img.naturalWidth
  const natH = img.naturalHeight
  if (!natW || !natH) return dataUrl

  const maxAnalysis = 1200
  const scale = Math.max(natW, natH) > maxAnalysis ? maxAnalysis / Math.max(natW, natH) : 1
  const w = Math.max(1, Math.round(natW * scale))
  const h = Math.max(1, Math.round(natH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)

  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData
  const gray = new Float32Array(w * h)

  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4
    gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114
  }

  const idx = (x, y) => y * w + x
  const sampleCorners = () => {
    const margin = Math.max(2, Math.floor(Math.min(w, h) * 0.02))
    const pts = [
      gray[idx(margin, margin)],
      gray[idx(w - 1 - margin, margin)],
      gray[idx(margin, h - 1 - margin)],
      gray[idx(w - 1 - margin, h - 1 - margin)],
    ]
    const mean = pts.reduce((a, b) => a + b, 0) / pts.length
    const variance = pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length
    return { mean, variance: Math.sqrt(variance) }
  }

  const { mean: bgMean, variance: cornerSpread } = sampleCorners()
  if (cornerSpread > 28) {
    return dataUrl
  }

  const threshold = Math.max(18, Math.min(40, 12 + cornerSpread * 0.6))
  const isBackground = (g) => Math.abs(g - bgMean) < threshold

  const visited = new Uint8Array(w * h)
  const queue = []
  const pushEdge = () => {
    for (let x = 0; x < w; x += 1) {
      const top = idx(x, 0)
      const bottom = idx(x, h - 1)
      if (!visited[top] && isBackground(gray[top])) {
        visited[top] = 1
        queue.push(top)
      }
      if (!visited[bottom] && isBackground(gray[bottom])) {
        visited[bottom] = 1
        queue.push(bottom)
      }
    }
    for (let y = 0; y < h; y += 1) {
      const left = idx(0, y)
      const right = idx(w - 1, y)
      if (!visited[left] && isBackground(gray[left])) {
        visited[left] = 1
        queue.push(left)
      }
      if (!visited[right] && isBackground(gray[right])) {
        visited[right] = 1
        queue.push(right)
      }
    }
  }

  pushEdge()
  while (queue.length) {
    const i = queue.pop()
    const x = i % w
    const y = (i / w) | 0
    const neighbors = [i - 1, i + 1, i - w, i + w]
    for (const n of neighbors) {
      if (n < 0 || n >= w * h) continue
      if (visited[n]) continue
      const nx = n % w
      const ny = (n / w) | 0
      if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue
      if (!isBackground(gray[n])) continue
      visited[n] = 1
      queue.push(n)
    }
  }

  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let found = false
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = idx(x, y)
      if (visited[i]) continue
      found = true
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (!found) return dataUrl

  const pad = Math.round(Math.min(w, h) * 0.02)
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad)
  maxY = Math.min(h - 1, maxY + pad)

  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  if (cw < w * 0.35 || ch < h * 0.35) return dataUrl

  const sx = (minX / w) * natW
  const sy = (minY / h) * natH
  const sw = (cw / w) * natW
  const sh = (ch / h) * natH

  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(sw))
  out.height = Math.max(1, Math.round(sh))
  const octx = out.getContext('2d')
  octx.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height)
  return canvasToJpegDataUrl(out, quality)
}
