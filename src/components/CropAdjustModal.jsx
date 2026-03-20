import { useCallback, useEffect, useRef, useState } from 'react'
import { clampCropNorm, cropDataUrlFromNormalized } from '../lib/cropUtils.js'

function getDisplayedImageRect(containerW, containerH, imgW, imgH) {
  if (!imgW || !imgH || !containerW || !containerH) {
    return { x: 0, y: 0, w: containerW || 1, h: containerH || 1 }
  }
  const scale = Math.min(containerW / imgW, containerH / imgH)
  const w = imgW * scale
  const h = imgH * scale
  const x = (containerW - w) / 2
  const y = (containerH - h) / 2
  return { x, y, w, h }
}

function applyDrag(kind, startCrop, dnx, dny) {
  const s = startCrop
  let next = { ...s }

  if (kind === 'move') {
    next.x = s.x + dnx
    next.y = s.y + dny
  } else if (kind === 'nw') {
    next.x = s.x + dnx
    next.y = s.y + dny
    next.w = s.w - dnx
    next.h = s.h - dny
  } else if (kind === 'ne') {
    next.y = s.y + dny
    next.w = s.w + dnx
    next.h = s.h - dny
  } else if (kind === 'sw') {
    next.x = s.x + dnx
    next.w = s.w - dnx
    next.h = s.h + dny
  } else if (kind === 'se') {
    next.w = s.w + dnx
    next.h = s.h + dny
  } else if (kind === 'n') {
    next.y = s.y + dny
    next.h = s.h - dny
  } else if (kind === 's') {
    next.h = s.h + dny
  } else if (kind === 'w') {
    next.x = s.x + dnx
    next.w = s.w - dnx
  } else if (kind === 'e') {
    next.w = s.w + dnx
  }

  return clampCropNorm(next)
}

const COPY = {
  import: {
    title: '確認掃描範圍',
    sub:
      '拖曳框出要當成「一頁文件」的區域（含紙張邊緣）。套用後會對此範圍做透視與掃描色調；全圖請按「還原全圖」。',
    apply: '套用並掃描',
    cancel: '略過此張',
  },
  edit: {
    title: '調整裁切範圍（3×3 參考格）',
    sub: '拖曳四角或邊緣縮放；拖曳中央平移。套用後會依新範圍重新掃描。',
    apply: '套用並重新掃描',
    cancel: '關閉（不套用）',
  },
}

/**
 * @param {object} props
 * @param {string|null} props.imageUrl
 * @param {'import'|'edit'} [props.variant]
 * @param {() => void} props.onClose 使用者取消／略過（backdrop、Escape、略過按鈕）
 * @param {(dataUrl: string) => void | Promise<void>} props.onApply 成功後由父層關閉 modal（更新 queue 或 cropTargetId）
 */
export function CropAdjustModal({ imageUrl, onClose, onApply, variant = 'edit' }) {
  const stageRef = useRef(null)
  const imgRef = useRef(null)
  const dispRef = useRef({ x: 0, y: 0, w: 1, h: 1 })
  const dialogRef = useRef(null)
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [disp, setDisp] = useState({ x: 0, y: 0, w: 1, h: 1 })
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 1, h: 1 })
  const [applyError, setApplyError] = useState('')
  const [isApplying, setIsApplying] = useState(false)

  useEffect(() => {
    dispRef.current = disp
  }, [disp])

  const measure = useCallback(() => {
    const stage = stageRef.current
    const img = imgRef.current
    if (!stage || !img || !img.complete || !natural.w) return
    const cr = stage.getBoundingClientRect()
    const d = getDisplayedImageRect(cr.width, cr.height, natural.w, natural.h)
    dispRef.current = d
    setDisp(d)
  }, [natural.w, natural.h])

  useEffect(() => {
    const ro = new ResizeObserver(() => measure())
    const el = stageRef.current
    if (el) ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 開啟時焦點移入對話框，利於鍵盤與螢幕閱讀器 */
  useEffect(() => {
    const t = window.setTimeout(() => {
      dialogRef.current?.querySelector('button')?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [imageUrl])

  const handleImgLoad = (e) => {
    const el = e.target
    setNatural({ w: el.naturalWidth, h: el.naturalHeight })
    requestAnimationFrame(() => measure())
  }

  const startDrag = (kind) => (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    const startCrop = { ...crop }
    const startX = ev.clientX
    const startY = ev.clientY
    const d0 = dispRef.current

    const move = (e) => {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      const d = dispRef.current
      const dw = d.w || d0.w || 1
      const dh = d.h || d0.h || 1
      const dnx = dx / dw
      const dny = dy / dh
      setCrop(applyDrag(kind, startCrop, dnx, dny))
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const resetFull = () => setCrop({ x: 0, y: 0, w: 1, h: 1 })

  const copy = COPY[variant] || COPY.edit

  const handleApply = async () => {
    if (!imageUrl) return
    setApplyError('')
    setIsApplying(true)
    try {
      const out = await cropDataUrlFromNormalized(imageUrl, crop, 0.93)
      await Promise.resolve(onApply(out))
      /** 成功後由父層關閉（import 佇列 slice / edit 清 cropTargetId），避免重複 onClose 與佇列錯位 */
    } catch (err) {
      setApplyError(err?.message || '裁切套用失敗，請再試一次。')
    } finally {
      setIsApplying(false)
    }
  }

  if (!imageUrl) return null

  const pxBox = {
    left: disp.x + crop.x * disp.w,
    top: disp.y + crop.y * disp.h,
    width: crop.w * disp.w,
    height: crop.h * disp.h,
  }

  const bottomShadeTop = pxBox.top + pxBox.height

  return (
    <div className="crop-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="crop-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crop-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="crop-modal-header">
          <h2 id="crop-modal-title">{copy.title}</h2>
          <p className="crop-modal-sub">{copy.sub}</p>
        </div>

        <div ref={stageRef} className="crop-stage">
          <img
            ref={imgRef}
            src={imageUrl}
            alt="裁切預覽"
            className="crop-stage-img"
            onLoad={handleImgLoad}
            draggable={false}
          />

          {natural.w > 0 && (
            <>
              <div
                className="crop-shade-piece crop-shade-top"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  height: pxBox.top,
                }}
              />
              <div
                className="crop-shade-mid"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: pxBox.top,
                  height: pxBox.height,
                  display: 'flex',
                }}
              >
                <div className="crop-shade-piece" style={{ width: pxBox.left, flex: 'none' }} />
                <div style={{ width: pxBox.width, flex: 'none' }} />
                <div className="crop-shade-piece" style={{ flex: 1, minWidth: 0 }} />
              </div>
              <div
                className="crop-shade-piece crop-shade-bottom"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: bottomShadeTop,
                  bottom: 0,
                }}
              />

              <div
                className="crop-box"
                style={{
                  left: pxBox.left,
                  top: pxBox.top,
                  width: pxBox.width,
                  height: pxBox.height,
                }}
              >
                <div className="crop-grid-3x3" aria-hidden />
                <button
                  type="button"
                  className="crop-move-surface"
                  aria-label="平移裁切區"
                  onPointerDown={startDrag('move')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-nw"
                  aria-label="調整左上角"
                  onPointerDown={startDrag('nw')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-ne"
                  aria-label="調整右上角"
                  onPointerDown={startDrag('ne')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-sw"
                  aria-label="調整左下角"
                  onPointerDown={startDrag('sw')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-se"
                  aria-label="調整右下角"
                  onPointerDown={startDrag('se')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-n"
                  aria-label="調整上邊"
                  onPointerDown={startDrag('n')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-s"
                  aria-label="調整下邊"
                  onPointerDown={startDrag('s')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-w"
                  aria-label="調整左邊"
                  onPointerDown={startDrag('w')}
                />
                <button
                  type="button"
                  className="crop-handle crop-handle-e"
                  aria-label="調整右邊"
                  onPointerDown={startDrag('e')}
                />
              </div>
            </>
          )}
        </div>

        {applyError ? <p className="crop-modal-error">{applyError}</p> : null}

        <div className="crop-modal-footer">
          <button type="button" className="button ghost" onClick={resetFull}>
            還原全圖
          </button>
          <button type="button" className="button ghost" onClick={onClose}>
            {copy.cancel}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={handleApply}
            disabled={isApplying}
          >
            {isApplying ? '掃描處理中…' : copy.apply}
          </button>
        </div>
      </div>
    </div>
  )
}
