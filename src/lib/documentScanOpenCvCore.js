/**
 * OpenCV 文件掃描核心（無 DOM canvas，供 Web Worker 與測試使用）
 */

/**
 * @param {{ width: number, height: number } | null | undefined} knownWH 若由主執行緒提供（與 JPEG 實際像素一致），可改走 createImageBitmap 的 resize 解碼，少一次全尺寸解碼。
 */
export async function decodeDataUrlToSrcMat(cv, dataUrl, maxLongEdge = 2000, knownWH = null) {
  const response = await fetch(dataUrl)
  const blob = await response.blob()

  let nw = knownWH?.width
  let nh = knownWH?.height
  if (!nw || !nh || nw < 1 || nh < 1) {
    const probe = await createImageBitmap(blob)
    nw = probe.width
    nh = probe.height
    probe.close()
  }
  if (!nw || !nh) {
    throw new Error('圖片尺寸無效')
  }

  const scale = Math.min(1, maxLongEdge / Math.max(nw, nh))
  const w = Math.max(1, Math.round(nw * scale))
  const h = Math.max(1, Math.round(nh * scale))

  let bitmap
  try {
    if (scale < 1 && typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high',
      })
    } else {
      bitmap = await createImageBitmap(blob)
    }
  } catch {
    bitmap = await createImageBitmap(blob)
  }

  try {
    const oc = new OffscreenCanvas(w, h)
    const ctx = oc.getContext('2d')
    ctx.drawImage(bitmap, 0, 0, w, h)
    const imageData = ctx.getImageData(0, 0, w, h)
    return cv.matFromImageData(imageData)
  } finally {
    bitmap.close()
  }
}

export async function matToJpegDataUrl(mat, quality) {
  const cols = mat.cols
  const rows = mat.rows
  const len = cols * rows * 4
  const raw = mat.data
  const clamped = new Uint8ClampedArray(len)
  if (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) {
    const take = Math.min(len, raw.byteLength - raw.byteOffset)
    clamped.set(new Uint8Array(raw.buffer, raw.byteOffset, take))
  }

  const imageData = new ImageData(clamped, cols, rows)
  const oc = new OffscreenCanvas(cols, rows)
  const ctx = oc.getContext('2d')
  ctx.putImageData(imageData, 0, 0)
  const blob = await oc.convertToBlob({ type: 'image/jpeg', quality })
  return await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('encode failed'))
    fr.readAsDataURL(blob)
  })
}

export function orderQuadPoints(pts) {
  const sums = pts.map((p) => p.x + p.y)
  const diffs = pts.map((p) => p.y - p.x)
  const tl = pts[sums.indexOf(Math.min(...sums))]
  const br = pts[sums.indexOf(Math.max(...sums))]
  const tr = pts[diffs.indexOf(Math.min(...diffs))]
  const bl = pts[diffs.indexOf(Math.max(...diffs))]
  return [tl, tr, br, bl]
}

export function quadWidthHeight(ordered) {
  const [tl, tr, br, bl] = ordered
  const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y)
  const wBot = Math.hypot(br.x - bl.x, br.y - bl.y)
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y)
  const hRight = Math.hypot(br.x - tr.x, br.y - tr.y)
  const maxW = Math.max(wTop, wBot)
  const maxH = Math.max(hLeft, hRight)
  return [Math.max(32, Math.round(maxW)), Math.max(32, Math.round(maxH))]
}

export function quadArea(ordered) {
  const [tl, tr, br, bl] = ordered
  const tri1 = Math.abs(tl.x * (tr.y - br.y) + tr.x * (br.y - tl.y) + br.x * (tl.y - tr.y)) / 2
  const tri2 = Math.abs(tl.x * (br.y - bl.y) + br.x * (bl.y - tl.y) + bl.x * (tl.y - br.y)) / 2
  return tri1 + tri2
}

export function isReasonableQuad(ordered, imgW, imgH, imgArea) {
  const [tl, tr, br, bl] = ordered
  const pad = Math.min(imgW, imgH) * 0.08
  const corners = [tl, tr, br, bl]
  for (const p of corners) {
    if (p.x < -pad || p.y < -pad || p.x > imgW + pad || p.y > imgH + pad) {
      return false
    }
  }

  const area = quadArea(ordered)
  const minA = imgArea * 0.08
  const maxA = imgArea * 0.96
  if (area < minA || area > maxA) return false

  const sides = [
    Math.hypot(tr.x - tl.x, tr.y - tl.y),
    Math.hypot(br.x - tr.x, br.y - tr.y),
    Math.hypot(bl.x - br.x, bl.y - br.y),
    Math.hypot(tl.x - bl.x, tl.y - bl.y),
  ]
  const minSide = Math.min(...sides)
  const maxSide = Math.max(...sides)
  if (minSide < Math.min(imgW, imgH) * 0.04) return false
  if (maxSide > Math.hypot(imgW, imgH) * 1.2) return false
  if (maxSide > minSide * 5) return false

  const [w, h] = quadWidthHeight(ordered)
  const ar = w / Math.max(1, h)
  if (ar < 0.35 || ar > 2.85) return false

  return true
}

function quadFromApprox(approx, scaleBack) {
  if (approx.rows !== 4) return null
  const pts = []
  for (let j = 0; j < 4; j += 1) {
    pts.push({
      x: approx.intAt(j, 0) / scaleBack,
      y: approx.intAt(j, 1) / scaleBack,
    })
  }
  return orderQuadPoints(pts)
}

const FULL_IMG_AREA = (dw, dh, scaleBack) => (dw * dh) / (scaleBack * scaleBack)
const FULL_W = (dw, scaleBack) => dw / scaleBack
const FULL_H = (dh, scaleBack) => dh / scaleBack

function quadFromContour(cv, cnt, imgArea, scaleBack, dw, dh) {
  const peri = cv.arcLength(cnt, true)
  if (peri < 35) return null

  const imgW = FULL_W(dw, scaleBack)
  const imgH = FULL_H(dh, scaleBack)
  const fullArea = FULL_IMG_AREA(dw, dh, scaleBack)

  for (const epsMul of [0.015, 0.02, 0.03, 0.045, 0.065, 0.09]) {
    const approx = new cv.Mat()
    cv.approxPolyDP(cnt, approx, epsMul * peri, true)
    const a = cv.contourArea(approx, false)
    if (approx.rows === 4 && a > imgArea * 0.06) {
      const q = quadFromApprox(approx, scaleBack)
      approx.delete()
      if (q && isReasonableQuad(q, imgW, imgH, fullArea)) {
        return q
      }
    } else {
      approx.delete()
    }
  }

  const hull = new cv.Mat()
  cv.convexHull(cnt, hull, false, true)
  const hullPeri = cv.arcLength(hull, true)
  if (hullPeri > 30) {
    for (const epsMul of [0.02, 0.03, 0.045, 0.06]) {
      const approx = new cv.Mat()
      cv.approxPolyDP(hull, approx, epsMul * hullPeri, true)
      const a = cv.contourArea(approx, false)
      if (approx.rows === 4 && a > imgArea * 0.06) {
        const q = quadFromApprox(approx, scaleBack)
        approx.delete()
        hull.delete()
        if (q && isReasonableQuad(q, imgW, imgH, fullArea)) {
          return q
        }
      } else {
        approx.delete()
      }
    }
  }
  hull.delete()

  const rect = cv.minAreaRect(cnt)
  const vertices = cv.RotatedRect.points(rect)
  const pts = vertices.map((p) => ({
    x: p.x / scaleBack,
    y: p.y / scaleBack,
  }))
  const q = orderQuadPoints(pts)
  if (isReasonableQuad(q, imgW, imgH, fullArea)) {
    return q
  }
  return null
}

function collectBestQuadFromContours(cv, contours, imgArea, scaleBack, dw, dh) {
  let best = null
  let bestArea = 0

  for (let i = 0; i < contours.size(); i += 1) {
    const cnt = contours.get(i)
    const cntArea = cv.contourArea(cnt, false)
    if (cntArea < imgArea * 0.06 || cntArea > imgArea * 0.99) {
      cnt.delete()
      continue
    }

    const q = quadFromContour(cv, cnt, imgArea, scaleBack, dw, dh)
    cnt.delete()
    if (!q) continue

    const a = quadArea(q)
    if (a > bestArea) {
      bestArea = a
      best = q
    }
  }

  return best
}

function clampOddMorphKernel(dw, dh, ratio, minK = 11, maxK = 21) {
  const base = Math.round(Math.min(dw, dh) * ratio)
  let k = Math.max(minK, Math.min(maxK, base))
  if (k % 2 === 0) k += 1
  return k
}

function meanBorderLuma(blurred, dw, dh) {
  const border = Math.max(3, Math.floor(Math.min(dw, dh) * 0.07))
  let sum = 0
  let n = 0
  const add = (y, x) => {
    sum += blurred.ucharAt(y, x)
    n += 1
  }
  for (let x = 0; x < dw; x += 1) {
    for (let y = 0; y < border; y += 1) add(y, x)
    for (let y = dh - border; y < dh; y += 1) add(y, x)
  }
  for (let y = border; y < dh - border; y += 1) {
    for (let x = 0; x < border; x += 1) add(y, x)
    for (let x = dw - border; x < dw; x += 1) add(y, x)
  }
  return n > 0 ? sum / n : 128
}

function detectQuadBrightPaperOnDesk(cv, gray, dw, dh, scaleBack) {
  const blurred = new cv.Mat()
  const bin = new cv.Mat()
  const closed = new cv.Mat()
  const opened = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  try {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT)

    const bgMean = meanBorderLuma(blurred, dw, dh)
    const t = Math.min(252, Math.max(bgMean + 18, 140))
    cv.threshold(blurred, bin, t, 255, cv.THRESH_BINARY)

    const kOdd = clampOddMorphKernel(dw, dh, 0.04, 15, 21)
    const kernelClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kOdd, kOdd))
    cv.morphologyEx(bin, closed, cv.MORPH_CLOSE, kernelClose)
    kernelClose.delete()

    const kernelOpen = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
    cv.morphologyEx(closed, opened, cv.MORPH_OPEN, kernelOpen)
    kernelOpen.delete()

    cv.findContours(opened, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const imgArea = dw * dh
    return collectBestQuadFromContours(cv, contours, imgArea, scaleBack, dw, dh)
  } finally {
    blurred.delete()
    bin.delete()
    closed.delete()
    opened.delete()
    contours.delete()
    hierarchy.delete()
  }
}

function detectQuadOtsuPaper(cv, gray, dw, dh, scaleBack) {
  const blurred = new cv.Mat()
  const bin = new cv.Mat()
  const closed = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  try {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT)
    cv.threshold(blurred, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)

    const whiteRatio = cv.countNonZero(bin) / (dw * dh)
    if (whiteRatio > 0.72) {
      cv.bitwise_not(bin, bin)
    }

    const kOdd = clampOddMorphKernel(dw, dh, 0.035, 13, 21)
    const kernelClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kOdd, kOdd))
    cv.morphologyEx(bin, closed, cv.MORPH_CLOSE, kernelClose)
    kernelClose.delete()

    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const imgArea = dw * dh
    return collectBestQuadFromContours(cv, contours, imgArea, scaleBack, dw, dh)
  } finally {
    blurred.delete()
    bin.delete()
    closed.delete()
    contours.delete()
    hierarchy.delete()
  }
}

function detectQuadCanny(cv, blurred, dw, dh, scaleBack, low, high, dilateIters) {
  const edges = new cv.Mat()
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  try {
    cv.Canny(blurred, edges, low, high, 3, false)
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), dilateIters, cv.BORDER_CONSTANT, new cv.Scalar(0))
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    const imgArea = dw * dh
    return collectBestQuadFromContours(cv, contours, imgArea, scaleBack, dw, dh)
  } finally {
    edges.delete()
    kernel.delete()
    contours.delete()
    hierarchy.delete()
  }
}

function quadScore(q, imgAreaFull) {
  if (!q) return -1
  const a = quadArea(q)
  const ratio = a / imgAreaFull
  if (ratio < 0.12 || ratio > 0.94) return -1
  return a
}

function pickBestQuad(candidates, imgAreaFull) {
  let best = null
  let bestS = -1
  for (const q of candidates) {
    const s = quadScore(q, imgAreaFull)
    if (s > bestS) {
      bestS = s
      best = q
    }
  }
  return best
}

function isStrongQuad(q, imgAreaFull) {
  if (!q) return false
  const a = quadArea(q)
  const ratio = a / imgAreaFull
  return ratio >= 0.14 && ratio <= 0.91
}

function detectDocumentQuad(cv, gray, dw, dh, ds) {
  const imgAreaFull = (dw * dh) / (ds * ds)

  const qBright = detectQuadBrightPaperOnDesk(cv, gray, dw, dh, ds)
  if (isStrongQuad(qBright, imgAreaFull)) {
    return qBright
  }

  const qOtsu = detectQuadOtsuPaper(cv, gray, dw, dh, ds)
  if (isStrongQuad(qOtsu, imgAreaFull)) {
    return pickBestQuad([qBright, qOtsu].filter(Boolean), imgAreaFull)
  }

  const blurred = new cv.Mat()
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT)

  const candidates = [qBright, qOtsu].filter(Boolean)

  for (const [lo, hi, dil] of [
    [30, 90, 2],
    [40, 120, 2],
  ]) {
    const qc = detectQuadCanny(cv, blurred, dw, dh, ds, lo, hi, dil)
    if (qc) {
      candidates.push(qc)
      if (isStrongQuad(qc, imgAreaFull)) {
        blurred.delete()
        return qc
      }
    }
  }

  const goodEnough = pickBestQuad(candidates, imgAreaFull)
  if (goodEnough && quadScore(goodEnough, imgAreaFull) > 0) {
    blurred.delete()
    return goodEnough
  }

  for (const [lo, hi, dil] of [
    [20, 60, 2],
    [15, 45, 2],
  ]) {
    const qc = detectQuadCanny(cv, blurred, dw, dh, ds, lo, hi, dil)
    if (qc) candidates.push(qc)
  }

  blurred.delete()
  return pickBestQuad(candidates, imgAreaFull)
}

/** 超過此像素數跳過 luminance polish（全圖逐像素成本高；CLAHE 已拉對比） */
const POLISH_MAX_PIXELS = 2_800_000

/**
 * 亮度分位數拉開（與主程式 polish 同概念），在 Worker 內改像素，避免主執行緒大圖 decode/upscale 卡死。
 * 僅處理連續 CV_8UC4（scannerLookLab 輸出通常為連續）。
 */
function polishRgbaMatLuminance(mat) {
  try {
    if (typeof mat.isContinuous === 'function' && !mat.isContinuous()) return
  } catch {
    return
  }

  const rows = mat.rows
  const cols = mat.cols
  if (rows < 4 || cols < 4) return

  const n = rows * cols
  if (n > POLISH_MAX_PIXELS) return

  const bytes = mat.data
  /** 取樣略減可省排序時間，對大圖影響極小 */
  const sampleStep = Math.max(1, Math.ceil(n / 100_000))
  const samples = []
  for (let j = 0; j < n; j += sampleStep) {
    const i = j * 4
    samples.push(bytes[i] * 0.299 + bytes[i + 1] * 0.587 + bytes[i + 2] * 0.114)
  }
  if (samples.length < 20) return
  samples.sort((a, b) => a - b)
  const lo = samples[Math.max(0, Math.floor(samples.length * 0.035))] ?? 0
  const hi = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.992))] ?? 255
  const range = Math.max(18, hi - lo)
  const mul = 255 / range

  for (let j = 0; j < n; j += 1) {
    const i = j * 4
    const r = bytes[i]
    const g = bytes[i + 1]
    const b = bytes[i + 2]
    const lum = r * 0.299 + g * 0.587 + b * 0.114
    const lum2 = Math.min(255, Math.max(0, (lum - lo) * mul))
    const k = lum > 2 ? lum2 / lum : 1
    bytes[i] = Math.min(255, Math.round(r * k))
    bytes[i + 1] = Math.min(255, Math.round(g * k))
    bytes[i + 2] = Math.min(255, Math.round(b * k))
  }
}

function scannerLookLab(cv, srcRgba) {
  const rgb = new cv.Mat()
  cv.cvtColor(srcRgba, rgb, cv.COLOR_RGBA2RGB, 0)

  const lab = new cv.Mat()
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab, 0)

  const mv = new cv.MatVector()
  cv.split(lab, mv)

  const L = mv.get(0)
  const A = mv.get(1)
  const Bch = mv.get(2)

  /** 較大 tile 減少分塊運算量，速度明顯優於 8×8，畫質仍接近掃描感 */
  const clahe = cv.createCLAHE(3.35, new cv.Size(12, 12))
  const L2 = new cv.Mat()
  clahe.apply(L, L2)
  clahe.delete()

  const mv2 = new cv.MatVector()
  mv2.push_back(L2)
  mv2.push_back(A)
  mv2.push_back(Bch)

  const lab2 = new cv.Mat()
  cv.merge(mv2, lab2)

  const rgb2 = new cv.Mat()
  cv.cvtColor(lab2, rgb2, cv.COLOR_Lab2RGB, 0)

  const rgbaOut = new cv.Mat()
  cv.cvtColor(rgb2, rgbaOut, cv.COLOR_RGB2RGBA, 0)

  rgb.delete()
  lab.delete()
  mv.delete()
  L.delete()
  A.delete()
  Bch.delete()
  L2.delete()
  mv2.delete()
  lab2.delete()
  rgb2.delete()

  return rgbaOut
}

const MAX_WARP_EDGE = 4500
const MAX_WARP_PIXELS = 14_000_000

/**
 * 透視／CLAHE 前將工作圖縮到此長邊以下（偵測仍用原圖推算的四角座標再換算）。
 * 對 3～4K 輸入可省大量 WASM 時間，畫質多數文件仍足夠。
 */
const WARP_WORK_MAX_LONG_EDGE = 2200

/**
 * 透視校正後裁掉多餘白邊（背景與文件對比），讓輸出更接近掃描範圍。
 * @returns {object | null} 新 cv.Mat；失敗回 null
 */
function tryTrimWhiteMargins(cv, mat) {
  const gray = new cv.Mat()
  const mask = new cv.Mat()
  let kernel = null
  try {
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY)
    cv.threshold(gray, mask, 246, 255, cv.THRESH_BINARY_INV)
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel)

    const rect = cv.boundingRect(mask)
    if (rect.width < 24 || rect.height < 24) return null

    const ratio = (rect.width * rect.height) / (mat.cols * mat.rows)
    if (ratio > 0.985 || ratio < 0.12) return null

    const pad = Math.max(4, Math.round(Math.min(mat.cols, mat.rows) * 0.012))
    const x = Math.max(0, rect.x - pad)
    const y = Math.max(0, rect.y - pad)
    const rw = Math.min(mat.cols - x, rect.width + 2 * pad)
    const rh = Math.min(mat.rows - y, rect.height + 2 * pad)
    if (rw < 32 || rh < 32) return null

    const r = new cv.Rect(x, y, rw, rh)
    const roi = mat.roi(r)
    const out = roi.clone()
    roi.delete()
    return out
  } catch {
    return null
  } finally {
    gray.delete()
    mask.delete()
    if (kernel) {
      try {
        kernel.delete()
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 已由 RGBA 像素建立的 src Mat（CV_8UC4）；此函式會負責 delete(src)。
 * @returns {Promise<string|null>}
 */
export async function runDocumentScanPipelineFromRgbaMat(cv, src, jpegQuality = 0.92) {
  const small = new cv.Mat()
  const gray = new cv.Mat()
  let workMat = src

  try {
    const w = src.cols
    const h = src.rows

    const detectMax = 600
    const ds = Math.min(1, detectMax / Math.max(w, h))
    const dw = Math.max(1, Math.round(w * ds))
    const dh = Math.max(1, Math.round(h * ds))

    cv.resize(src, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA)
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY, 0)

    let ordered = detectDocumentQuad(cv, gray, dw, dh, ds)
    if (!ordered) {
      return null
    }

    const longIn = Math.max(w, h)
    if (longIn > WARP_WORK_MAX_LONG_EDGE) {
      const sw = WARP_WORK_MAX_LONG_EDGE / longIn
      const w2 = Math.max(1, Math.round(w * sw))
      const h2 = Math.max(1, Math.round(h * sw))
      const down = new cv.Mat()
      cv.resize(workMat, down, new cv.Size(w2, h2), 0, 0, cv.INTER_AREA)
      try {
        workMat.delete()
      } catch {
        /* ignore */
      }
      workMat = down
      const sx = w2 / w
      const sy = h2 / h
      ordered = ordered.map((p) => ({ x: p.x * sx, y: p.y * sy }))
    }

    const [maxW, maxH] = quadWidthHeight(ordered)
    if (maxW > MAX_WARP_EDGE || maxH > MAX_WARP_EDGE || maxW * maxH > MAX_WARP_PIXELS) {
      return null
    }

    const [tl, tr, br, bl] = ordered

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y])
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxW - 1, 0, maxW - 1, maxH - 1, 0, maxH - 1])
    const M = cv.getPerspectiveTransform(srcTri, dstTri)
    const warped = new cv.Mat()
    cv.warpPerspective(
      workMat,
      warped,
      M,
      new cv.Size(maxW, maxH),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    )

    let docMat = warped
    const trimmed = tryTrimWhiteMargins(cv, warped)
    if (trimmed) {
      warped.delete()
      docMat = trimmed
    }

    const enhanced = scannerLookLab(cv, docMat)
    docMat.delete()
    srcTri.delete()
    dstTri.delete()
    M.delete()

    polishRgbaMatLuminance(enhanced)
    const url = await matToJpegDataUrl(enhanced, jpegQuality)
    enhanced.delete()
    return url
  } catch {
    return null
  } finally {
    try {
      workMat.delete()
    } catch {
      /* ignore */
    }
    small.delete()
    gray.delete()
  }
}

/** @returns {Promise<string|null>} */
export async function runDocumentScanPipeline(
  cv,
  dataUrl,
  jpegQuality = 0.92,
  maxDecodeLongEdge = 2000,
  knownDecodeWH = null,
) {
  let src = null
  try {
    src = await decodeDataUrlToSrcMat(cv, dataUrl, maxDecodeLongEdge, knownDecodeWH)
  } catch {
    return null
  }
  return runDocumentScanPipelineFromRgbaMat(cv, src, jpegQuality)
}
