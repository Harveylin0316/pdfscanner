/**
 * 僅讀取檔頭推斷寬高，避免大 PNG／JPEG 為了縮圖而先全像素解碼。
 * 失敗時回傳 null，呼叫端應走完整 decode。
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

/** 尋找 JPEG SOF0–SOF15（略過 DHT/DAC 等非 SOF） */
function readJpegDimensions(u8) {
  let i = 0
  while (i < u8.length - 9) {
    if (u8[i] !== 0xff) {
      i += 1
      continue
    }
    let b = u8[i + 1]
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

    const isSof =
      b >= 0xc0 &&
      b <= 0xcf &&
      b !== 0xc4 &&
      b !== 0xc8 &&
      b !== 0xcc

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

/**
 * @param {Uint8Array} u8
 * @returns {{ w: number, h: number } | null}
 */
export function probeDimensionsFromBytes(u8) {
  return (
    readPngDimensions(u8) ||
    readGifDimensions(u8) ||
    readBmpDimensions(u8) ||
    readJpegDimensions(u8)
  )
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
