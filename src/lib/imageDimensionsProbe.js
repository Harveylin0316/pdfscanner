/**
 * 僅讀取檔頭推斷寬高或 MIME，避免大圖為了縮圖而先全像素解碼。
 */

const HEAD_BYTES = 262144

function readPngDimensions(u8) {
  if (u8.length < 24) return null
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let j = 0; j < 8; j += 1) {
    if (u8[j] !== sig[j]) return null
  }
  if (u8[12] !== 0x49 || u8[13] !== 0x48 || u8[14] !== 0x44 || u8[15] !== 0x52) return null
  const w = (u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19]
  const h = (u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23]
  if (w > 0 && h > 0 && w < 100000 && h < 100000) return { w, h }
  return null
}

function readGifDimensions(u8) {
  if (u8.length < 10) return null
  if (u8[0] !== 0x47 || u8[1] !== 0x49 || u8[2] !== 0x46) return null
  const w = u8[6] | (u8[7] << 8)
  const h = u8[8] | (u8[9] << 8)
  if (w > 0 && h > 0) return { w, h }
  return null
}

function readJpegDimensions(u8) {
  let i = 0
  while (i < u8.length - 9) {
    if (u8[i] !== 0xff) {
      i += 1
      continue
    }
    const b = u8[i + 1]
    if (b === 0xff) {
      i += 1
      continue
    }
    if (b === 0x00) {
      i += 2
      continue
    }
    if (b === 0xd8 || b === 0xd9) {
      i += 2
      continue
    }

    const isSof = b >= 0xc0 && b <= 0xcf && b !== 0xc4 && b !== 0xc8 && b !== 0xcc

    if (isSof) {
      const h = (u8[i + 5] << 8) | u8[i + 6]
      const w = (u8[i + 7] << 8) | u8[i + 8]
      if (w > 0 && h > 0) return { w, h }
    }

    const segLen = (u8[i + 2] << 8) | u8[i + 3]
    if (segLen < 2 || i + 2 + segLen > u8.length) {
      i += 2
      continue
    }
    i += 2 + segLen
  }
  return null
}

function readBmpDimensions(u8) {
  if (u8.length < 26) return null
  if (u8[0] !== 0x42 || u8[1] !== 0x4d) return null
  const w = u8[18] | (u8[19] << 8) | (u8[20] << 16) | (u8[21] << 24)
  const hRaw = u8[22] | (u8[23] << 8) | (u8[24] << 16) | (u8[25] << 24)
  const h = Math.abs(hRaw)
  if (w > 0 && h > 0 && w < 100000 && h < 100000) return { w, h }
  return null
}

/** WebP：RIFF…WEBP，VP8／VP8L chunk */
function readWebpDimensions(u8) {
  if (u8.length < 30) return null
  if (u8[0] !== 0x52 || u8[1] !== 0x49 || u8[2] !== 0x46 || u8[3] !== 0x46) return null
  if (u8[8] !== 0x57 || u8[9] !== 0x45 || u8[10] !== 0x42 || u8[11] !== 0x50) return null
  let o = 12
  while (o + 8 <= u8.length) {
    const tag = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])
    const sz = u8[o + 4] | (u8[o + 5] << 8) | (u8[o + 6] << 16) | (u8[o + 7] << 24)
    const dataStart = o + 8
    if (sz < 0 || dataStart + sz > u8.length) break
    const alignSz = sz + (sz & 1)
    if (tag === 'VP8 ' && dataStart + 10 < u8.length) {
      const d = dataStart
      if (u8[d] === 0x9d && u8[d + 1] === 0x01 && u8[d + 2] === 0x2a) {
        const w = 1 + ((u8[d + 6] | (u8[d + 7] << 8)) & 0x3fff)
        const h = 1 + ((u8[d + 8] | (u8[d + 9] << 8)) & 0x3fff)
        if (w > 16 && h > 16) return { w, h }
      }
    }
    if (tag === 'VP8L' && dataStart + 5 < u8.length) {
      const d = dataStart
      if (u8[d] === 0x2f) {
        const bits = u8[d + 1] | (u8[d + 2] << 8) | (u8[d + 3] << 16) | (u8[d + 4] << 24)
        const w = 1 + (bits & 0x3fff)
        const h = 1 + ((bits >> 14) & 0x3fff)
        if (w > 0 && h > 0) return { w, h }
      }
    }
    o = dataStart + alignSz
  }
  return null
}

/** ISO-BMFF ftyp：辨識 AVIF（無法在此讀像素，供 ImageDecoder 用 MIME） */
function readAvifMimeHint(u8) {
  if (u8.length < 16) return null
  if (u8[4] !== 0x66 || u8[5] !== 0x74 || u8[6] !== 0x79 || u8[7] !== 0x70) return null
  const brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11])
  if (brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'miaf') {
    return 'image/avif'
  }
  return null
}

/**
 * @param {Uint8Array} u8
 * @returns {{ w: number, h: number } | null}
 */
export function probeDimensionsFromBytes(u8) {
  return (
    readPngDimensions(u8) ||
    readGifDimensions(u8) ||
    readBmpDimensions(u8) ||
    readWebpDimensions(u8) ||
    readJpegDimensions(u8)
  )
}

/**
 * @param {Uint8Array} u8
 * @returns {string} MIME 或 ''
 */
export function sniffImageMimeTypeFromBytes(u8) {
  const avif = readAvifMimeHint(u8)
  if (avif) return avif
  if (readPngDimensions(u8)) return 'image/png'
  if (readGifDimensions(u8)) return 'image/gif'
  if (readBmpDimensions(u8)) return 'image/bmp'
  if (readWebpDimensions(u8)) return 'image/webp'
  if (readJpegDimensions(u8)) return 'image/jpeg'
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg'
  return ''
}

/**
 * @param {Blob} blob
 * @returns {Promise<{ w: number, h: number } | null>}
 */
export async function probeImageDimensionsFromBlob(blob) {
  try {
    const slice = blob.slice(0, HEAD_BYTES)
    const buf = await slice.arrayBuffer()
    const u8 = new Uint8Array(buf)
    return probeDimensionsFromBytes(u8)
  } catch {
    return null
  }
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function sniffImageMimeTypeFromBlob(blob) {
  try {
    const slice = blob.slice(0, 512)
    const buf = await slice.arrayBuffer()
    return sniffImageMimeTypeFromBytes(new Uint8Array(buf))
  } catch {
    return ''
  }
}
