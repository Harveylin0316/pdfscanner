import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import { CropAdjustModal } from '../components/CropAdjustModal.jsx'
import { convertHeicToJpegDataUrl } from '../lib/heicConvert.js'
import {
  applyOpenCvDocumentScanFromBitmap,
  SCAN_MODE,
  warmUpOpenCv,
} from '../lib/documentScanOpenCv.js'
import { createScaledScanBitmap } from '../lib/scanBitmapInput.js'
import { autoCropByCornerBackground, enhanceDocumentScanAggressive } from '../lib/scanPreprocess.js'
import '../App.css'

const PDF_SIZE_OPTIONS = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
]

const MARGIN_PRESETS = {
  none: 0,
  normal: 10,
  wide: 20,
}

/** 接近掃描器／列印用 PDF：高檔用 0.95，避免多輪 JPEG 後文字發糊 */
const JPEG_QUALITY_PRESETS = {
  high: 0.95,
  medium: 0.85,
  low: 0.68,
}

/** jsPDF 內嵌圖片串流壓縮；高檔用 SLOW 較利於畫質與檔案平衡 */
const PDF_IMAGE_COMPRESSION = {
  high: 'SLOW',
  medium: 'MEDIUM',
  low: 'FAST',
}

/** 掃描管線長邊下限（可調低以換取速度；與 OpenCV Worker 解碼上限需一致） */
const SCAN_PIPELINE_MIN_LONG_EDGE = 1600
/** 送進 OpenCV Worker 的 bitmap 長邊硬上限（Worker 內 getImageData／WASM 與此成正比；主執行緒不讀像素） */
const OPEN_CV_PIPELINE_BITMAP_MAX_LONG_EDGE = 2000
/** 極速模式送 Worker 的 bitmap 長邊（與 core INSTANT_MAX_LONG_EDGE 對齊思路） */
const INSTANT_PIPELINE_BITMAP_MAX_LONG_EDGE = 1600
/** 約 300dpi A4 長邊量級，與下方表單「圖片長邊上限」上限一致 */
const SCAN_PIPELINE_CAP_LONG_EDGE = 4000
/** 僅備援路徑（無 ImageBitmap 時）送 JPEG；快路徑已用 bitmap 免此步 */
const SCAN_PIPELINE_PREJPEG_QUALITY = 'medium'
/** PDF 內嵌圖片長邊上限（從掃描原圖 baseSrc 取樣，宜與管線上限一致） */
const PDF_EXPORT_MAX_LONG_EDGE = 4000

const IMAGE_EDGE_MIN = 800
const IMAGE_EDGE_MAX = 4000

/** 解碼／縮圖若超時則中斷，避免 UI 永遠停在「匯入中」 */
const IMPORT_DECODE_TIMEOUT_MS = 75_000

function withTimeout(promise, ms, message) {
  let timeoutId
  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timeoutId)
        resolve(v)
      },
      (e) => {
        clearTimeout(timeoutId)
        reject(e)
      },
    )
  })
}

const COMMON_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'avif',
  'svg',
  'tif',
  'tiff',
  'ico',
  'jfif',
  'pjpeg',
  'pjp',
  'heif',
])

function ToolPage() {
  const [images, setImages] = useState([])
  const [isCameraOpen, setIsCameraOpen] = useState(false)
  const [cameraMode, setCameraMode] = useState('single')
  const [isExporting, setIsExporting] = useState(false)
  const [isProcessingImages, setIsProcessingImages] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const [downloadNotice, setDownloadNotice] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [pdfPageSize, setPdfPageSize] = useState('a4')
  const [pdfMarginPreset, setPdfMarginPreset] = useState('normal')
  const [pdfOutputQuality, setPdfOutputQuality] = useState('high')
  const [pdfFileName, setPdfFileName] = useState('scanned-document')
  /** 預設略降以縮短掃描時間；需要更清晰可手動拉高「圖片長邊上限」 */
  const [maxImageEdge, setMaxImageEdge] = useState(2200)
  const [imageCompressionQuality, setImageCompressionQuality] = useState('high')
  /** 未勾選＝極速（略過透視偵測）；勾選＝完整 OpenCV 管線 */
  const [fullOpenCvScan, setFullOpenCvScan] = useState(false)
  const [cropTargetId, setCropTargetId] = useState(null)
  /** 上傳／拍照後先排隊，逐一開裁切 modal，套用後才跑掃描管線 */
  const [importCropQueue, setImportCropQueue] = useState([])
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const uploadSingleInputRef = useRef(null)
  const uploadBatchInputRef = useRef(null)

  const imageCountLabel = useMemo(() => {
    if (images.length === 0) return '尚未加入圖片'
    return `目前共 ${images.length} 張`
  }, [images])

  const stopCamera = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    stream.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [stopCamera])

  useEffect(
    () => () => {
      if (downloadNotice?.url) {
        URL.revokeObjectURL(downloadNotice.url)
      }
    },
    [downloadNotice],
  )

  useEffect(() => {
    if (isCameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [isCameraOpen])

  /** 刪除圖片後若裁切對象已不存在，關閉 modal 避免幽靈狀態 */
  useEffect(() => {
    if (cropTargetId != null && !images.some((im) => im.id === cropTargetId)) {
      setCropTargetId(null)
    }
  }, [cropTargetId, images])

  useEffect(() => {
    const kick = () => warmUpOpenCv()
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(kick, { timeout: 4000 })
      return () => cancelIdleCallback(id)
    }
    const t = window.setTimeout(kick, 1200)
    return () => clearTimeout(t)
  }, [])

  const readBlobAsDataUrl = useCallback(
    (blob, fileName = 'image') =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error(`無法讀取檔案：${fileName}`))
        reader.readAsDataURL(blob)
      }),
    [],
  )

  const readFileAsDataUrl = useCallback(
    (file) => readBlobAsDataUrl(file, file.name),
    [readBlobAsDataUrl],
  )

  const loadImage = useCallback(
    (dataUrl) =>
      new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('圖片解析失敗'))
        img.src = dataUrl
      }),
    [],
  )

  const compressImageWithDimensions = useCallback(
    async (dataUrl, maxEdge, qualityPreset) => {
      const image = await loadImage(dataUrl)
      const longestEdge = Math.max(image.width, image.height)
      const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1

      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))

      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)

      const quality = JPEG_QUALITY_PRESETS[qualityPreset] || JPEG_QUALITY_PRESETS.medium
      return {
        dataUrl: canvas.toDataURL('image/jpeg', quality),
        width: canvas.width,
        height: canvas.height,
      }
    },
    [loadImage],
  )

  const compressImage = useCallback(
    async (dataUrl, maxEdge, qualityPreset) => {
      const { dataUrl: out } = await compressImageWithDimensions(dataUrl, maxEdge, qualityPreset)
      return out
    },
    [compressImageWithDimensions],
  )

  /**
   * @param {string} displaySrc 列表預覽用（可依「圖片壓縮品質」縮小）
   * @param {string} fileName
   * @param {string | null} [fullSrc] 掃描管線輸出；PDF／裁切用，避免預覽壓縮拖累列印品質
   */
  const toImageItem = useCallback(
    (displaySrc, fileName = 'photo', fullSrc = null) => ({
      id:
        globalThis.crypto?.randomUUID?.() ??
        `img-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      src: displaySrc,
      baseSrc: fullSrc ?? displaySrc,
      name: `${fileName}.jpg`,
    }),
    [],
  )

  const getFileBaseName = (fileName) => fileName.replace(/\.[^.]+$/, '')

  const getFileExtension = (fileName) => {
    const matched = fileName.toLowerCase().match(/\.([^.]+)$/)
    return matched?.[1] || ''
  }

  const isHeicFile = (file) => {
    const type = (file.type || '').toLowerCase()
    const extension = getFileExtension(file.name)
    return (
      type.includes('image/heic') ||
      type.includes('image/heif') ||
      extension === 'heic' ||
      extension === 'heif'
    )
  }

  const isLikelyImageFile = (file) => {
    if ((file.type || '').startsWith('image/')) return true
    return COMMON_IMAGE_EXTENSIONS.has(getFileExtension(file.name))
  }

  const yieldToUi = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })

  const scanPipelineInputLongEdge = useMemo(
    () =>
      Math.min(
        SCAN_PIPELINE_CAP_LONG_EDGE,
        Math.max(maxImageEdge, SCAN_PIPELINE_MIN_LONG_EDGE),
      ),
    [maxImageEdge],
  )

  /** OpenCV 偵測不到紙張時：主執行緒簡易裁切＋加強（不重複跑 WASM，因快路徑像素相同） */
  const runCanvasFallbackPipeline = useCallback(
    async (dataUrl) => {
      const qHigh = JPEG_QUALITY_PRESETS.high
      const me = Math.min(3600, scanPipelineInputLongEdge)
      try {
        let url = await autoCropByCornerBackground(dataUrl, qHigh)
        await yieldToUi()
        url = await enhanceDocumentScanAggressive(url, qHigh, me)
        return url
      } catch {
        return dataUrl
      }
    },
    [scanPipelineInputLongEdge],
  )

  const finalizeImageForList = useCallback(
    async (pipelineDataUrl) => {
      const maxEdge = scanPipelineInputLongEdge
      if (imageCompressionQuality === 'high') {
        const img = await loadImage(pipelineDataUrl)
        const longest = Math.max(img.width, img.height)
        if (longest <= maxEdge) {
          return pipelineDataUrl
        }
      }
      return compressImage(pipelineDataUrl, maxEdge, imageCompressionQuality)
    },
    [compressImage, imageCompressionQuality, loadImage, scanPipelineInputLongEdge],
  )

  /**
   * 對「使用者確認後的裁切圖」跑掃描管線（OpenCV 透視／色階等），回傳列表用 src 與 PDF 用 baseSrc。
   * @param {string} croppedDataUrl JPEG data URL
   */
  const runScanPipelineOnCroppedDataUrl = useCallback(
    async (croppedDataUrl) => {
      const bitmapCap = fullOpenCvScan
        ? OPEN_CV_PIPELINE_BITMAP_MAX_LONG_EDGE
        : INSTANT_PIPELINE_BITMAP_MAX_LONG_EDGE
      const edge = Math.min(scanPipelineInputLongEdge, bitmapCap)
      /** Worker 內 JPEG 編碼用「中」可明顯加速；PDF 匯出仍可用高品質重採樣 */
      const qScanEncode = JPEG_QUALITY_PRESETS.medium
      const scanMode = fullOpenCvScan ? SCAN_MODE.full : SCAN_MODE.instant
      let pipelineUrl = null
      let pendingBitmap = null
      try {
        const { bitmap } = await withTimeout(
          createScaledScanBitmap(croppedDataUrl, edge, 'image/jpeg'),
          IMPORT_DECODE_TIMEOUT_MS,
          '圖片讀取逾時。請嘗試降低「圖片長邊上限」或改較小解析度截圖後再匯入。',
        )
        pendingBitmap = bitmap
        await yieldToUi()
        pipelineUrl = await applyOpenCvDocumentScanFromBitmap(bitmap, qScanEncode, { scanMode })
        pendingBitmap = null
      } catch {
        if (pendingBitmap) {
          try {
            pendingBitmap.close()
          } catch {
            /* ignore */
          }
          pendingBitmap = null
        }
      }

      if (!pipelineUrl) {
        const { dataUrl: ready } = await compressImageWithDimensions(
          croppedDataUrl,
          edge,
          SCAN_PIPELINE_PREJPEG_QUALITY,
        )
        await yieldToUi()
        pipelineUrl = await runCanvasFallbackPipeline(ready)
      }

      await yieldToUi()
      const storedUrl = await finalizeImageForList(pipelineUrl)
      return { storedUrl, pipelineUrl }
    },
    [
      compressImageWithDimensions,
      finalizeImageForList,
      runCanvasFallbackPipeline,
      fullOpenCvScan,
      scanPipelineInputLongEdge,
    ],
  )

  const cropModalUrl = useMemo(() => {
    const im = images.find((item) => item.id === cropTargetId)
    return im?.baseSrc ?? im?.src ?? null
  }, [images, cropTargetId])

  const importHead = useMemo(() => importCropQueue[0] ?? null, [importCropQueue])

  const newImportQueueId = useCallback(
    () =>
      globalThis.crypto?.randomUUID?.() ??
      `imp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    [],
  )

  /** 匯入佇列：略過目前這張（不掃描） */
  const handleImportSkip = useCallback((head) => {
    if (!head) return
    setImportCropQueue((q) => (q[0]?.id === head.id ? q.slice(1) : q))
  }, [])

  /** 匯入佇列：套用裁切後掃描並加入列表 */
  const handleImportCropApply = useCallback(
    async (croppedDataUrl, head) => {
      if (!head) return
      setIsProcessingImages(true)
      try {
        const { storedUrl, pipelineUrl } = await runScanPipelineOnCroppedDataUrl(croppedDataUrl)
        setImages((prev) => [...prev, toImageItem(storedUrl, head.fileName, pipelineUrl)])
        setImportCropQueue((q) => (q[0]?.id === head.id ? q.slice(1) : q))
        setErrorMessage('')
      } catch (err) {
        setErrorMessage(err?.message || '掃描失敗，請再試。')
        throw err
      } finally {
        setIsProcessingImages(false)
      }
    },
    [runScanPipelineOnCroppedDataUrl, toImageItem],
  )

  /** 列表項目：重新裁切後依新範圍再跑掃描管線 */
  const handleCropApplyFromModal = useCallback(
    async (croppedDataUrl) => {
      const id = cropTargetId
      if (!id) return
      setIsProcessingImages(true)
      try {
        const { storedUrl, pipelineUrl } = await runScanPipelineOnCroppedDataUrl(croppedDataUrl)
        setImages((prev) =>
          prev.map((im) =>
            im.id === id ? { ...im, baseSrc: pipelineUrl, src: storedUrl } : im,
          ),
        )
        setErrorMessage('')
        setCropTargetId(null)
      } catch (err) {
        setErrorMessage(err?.message || '重新掃描失敗，請再試。')
        throw err
      } finally {
        setIsProcessingImages(false)
      }
    },
    [cropTargetId, runScanPipelineOnCroppedDataUrl],
  )

  const getSafeFileName = (value) => {
    const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, '-')
    if (!normalized) return 'scanned-document.pdf'
    return normalized.toLowerCase().endsWith('.pdf') ? normalized : `${normalized}.pdf`
  }

  const triggerDownload = (url, fileName) => {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.click()
  }

  const handleUpload = async (event, mode = 'batch') => {
    const files = Array.from(event.target.files || [])
    if (files.length === 0) return

    setErrorMessage('')
    setIsProcessingImages(true)
    try {
      const targetFiles = mode === 'single' ? files.slice(0, 1) : files
      const successItems = []
      const failItems = []

      setUploadProgress({
        mode,
        total: targetFiles.length,
        current: 0,
        currentFileName: '',
      })

      for (let index = 0; index < targetFiles.length; index += 1) {
        const file = targetFiles[index]
        setUploadProgress({
          mode,
          total: targetFiles.length,
          current: index + 1,
          currentFileName: file.name,
        })

        try {
          if (!isHeicFile(file) && !isLikelyImageFile(file)) {
            throw new Error(`不支援的檔案格式：${file.name}`)
          }
          const heic = isHeicFile(file)
          let dataUrl
          if (heic) {
            dataUrl = await convertHeicToJpegDataUrl(file, maxImageEdge)
          } else {
            dataUrl = await readFileAsDataUrl(file)
          }
          await yieldToUi()
          const name = getFileBaseName(file.name) || `upload-${index + 1}`
          successItems.push({
            id: newImportQueueId(),
            fileName: name,
            dataUrl,
          })
        } catch (error) {
          failItems.push(error)
        }
      }

      if (successItems.length > 0) {
        setImportCropQueue((prev) => [...prev, ...successItems])
      }

      if (failItems.length > 0) {
        const names = failItems
          .slice(0, 3)
          .map((error) => error?.message?.replace('不支援的檔案格式：', '') || '未知檔案')
          .join('、')
        const suffix = failItems.length > 3 ? '...' : ''
        setErrorMessage(`有 ${failItems.length} 個檔案匯入失敗：${names}${suffix}`)
      }
    } catch (error) {
      setErrorMessage(error.message || '上傳失敗，請再試一次。')
    } finally {
      setIsProcessingImages(false)
      setUploadProgress(null)
      const input = event?.target
      if (input && 'value' in input) {
        input.value = ''
      }
    }
  }

  const startCamera = async (mode) => {
    setErrorMessage('')
    setCameraMode(mode)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })
      streamRef.current = stream
      setIsCameraOpen(true)
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
    } catch {
      setErrorMessage('無法開啟相機，請確認權限或 HTTPS 環境。')
    }
  }

  const closeCamera = () => {
    setIsCameraOpen(false)
    setCameraMode('single')
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    stopCamera()
  }

  const capturePhoto = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0)
    setErrorMessage('')

    const dataUrl = canvas.toDataURL('image/jpeg', 0.95)
    setImportCropQueue((q) => [
      ...q,
      {
        id: newImportQueueId(),
        fileName: `capture-${q.length + 1}`,
        dataUrl,
      },
    ])
    if (cameraMode === 'single') {
      closeCamera()
    }
  }

  const removeImage = (id) => {
    setImages((prev) => prev.filter((image) => image.id !== id))
  }

  const moveImage = (index, direction) => {
    setImages((prev) => {
      const targetIndex = index + direction
      if (targetIndex < 0 || targetIndex >= prev.length) return prev
      const copied = [...prev]
      ;[copied[index], copied[targetIndex]] = [copied[targetIndex], copied[index]]
      return copied
    })
  }

  const exportPdf = async () => {
    if (images.length === 0) return

    setErrorMessage('')
    setIsExporting(true)
    try {
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: pdfPageSize,
      })

      const margin = MARGIN_PRESETS[pdfMarginPreset] ?? MARGIN_PRESETS.normal
      const exportCompression = PDF_IMAGE_COMPRESSION[pdfOutputQuality] || 'MEDIUM'

      for (let index = 0; index < images.length; index += 1) {
        const image = images[index]
        const exportSrc = await compressImage(
          image.baseSrc ?? image.src,
          PDF_EXPORT_MAX_LONG_EDGE,
          pdfOutputQuality,
        )
        const imageEl = await loadImage(exportSrc)
        const width = imageEl.width
        const height = imageEl.height
        const pageWidth = pdf.internal.pageSize.getWidth()
        const pageHeight = pdf.internal.pageSize.getHeight()
        const contentWidth = Math.max(1, pageWidth - margin * 2)
        const contentHeight = Math.max(1, pageHeight - margin * 2)

        const scale = Math.min(contentWidth / width, contentHeight / height)
        const renderWidth = width * scale
        const renderHeight = height * scale
        const x = margin + (contentWidth - renderWidth) / 2
        const y = margin + (contentHeight - renderHeight) / 2

        if (index > 0) {
          pdf.addPage()
        }
        pdf.addImage(
          exportSrc,
          'JPEG',
          x,
          y,
          renderWidth,
          renderHeight,
          undefined,
          exportCompression,
          0,
        )
        await yieldToUi()
      }

      const safeFileName = getSafeFileName(pdfFileName)
      const blob = pdf.output('blob')
      const objectUrl = URL.createObjectURL(blob)

      setDownloadNotice((prev) => {
        if (prev?.url) {
          URL.revokeObjectURL(prev.url)
        }
        return { fileName: safeFileName, url: objectUrl }
      })

      triggerDownload(objectUrl, safeFileName)
    } catch (error) {
      setErrorMessage(error.message || 'PDF 產生失敗，請稍後再試。')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <main className="app">
      {importHead ? (
        <CropAdjustModal
          key={`import-${importHead.id}`}
          variant="import"
          imageUrl={importHead.dataUrl}
          onClose={() => handleImportSkip(importHead)}
          onApply={(cropped) => handleImportCropApply(cropped, importHead)}
        />
      ) : cropTargetId != null && cropModalUrl ? (
        <CropAdjustModal
          key={cropTargetId}
          variant="edit"
          imageUrl={cropModalUrl}
          onClose={() => setCropTargetId(null)}
          onApply={handleCropApplyFromModal}
        />
      ) : null}
      <header className="header">
        <h1>文件掃描</h1>
        <p>
          上傳或拍照 → <strong>確認裁切範圍</strong> → 自動掃描 → 匯出 <strong>PDF</strong>。
        </p>
      </header>

      <section className="card controls">
        <div className="button-group">
          <button
            type="button"
            className="button secondary"
            onClick={() => uploadSingleInputRef.current?.click()}
            disabled={isProcessingImages}
          >
            上傳單張
          </button>
          <input
            ref={uploadSingleInputRef}
            type="file"
            accept="image/*,.heic,.heif"
            onChange={(event) => handleUpload(event, 'single')}
            disabled={isProcessingImages}
            className="hidden-file-input"
          />

          <button
            type="button"
            className="button secondary"
            onClick={() => uploadBatchInputRef.current?.click()}
            disabled={isProcessingImages}
          >
            上傳批次
          </button>
          <input
            ref={uploadBatchInputRef}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            onChange={(event) => handleUpload(event, 'batch')}
            disabled={isProcessingImages}
            className="hidden-file-input"
          />

          {!isCameraOpen ? (
            <>
              <button
                type="button"
                className="button secondary"
                onClick={() => startCamera('single')}
                disabled={isProcessingImages}
              >
                相機單拍
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => startCamera('batch')}
                disabled={isProcessingImages}
              >
                相機批拍
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button secondary"
                onClick={capturePhoto}
                disabled={isProcessingImages}
              >
                {isProcessingImages ? '處理中...' : cameraMode === 'single' ? '拍照（單拍）' : '拍照（批拍）'}
              </button>
              {cameraMode === 'batch' ? (
                <>
                  <button
                    type="button"
                    className="button primary"
                    onClick={closeCamera}
                    disabled={isProcessingImages}
                  >
                    完成批拍
                  </button>
                  <button
                    type="button"
                    className="button ghost"
                    onClick={closeCamera}
                    disabled={isProcessingImages}
                  >
                    取消批拍
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button ghost"
                  onClick={closeCamera}
                  disabled={isProcessingImages}
                >
                  關閉相機
                </button>
              )}
            </>
          )}
        </div>

        {isCameraOpen && (
          <div className="camera-box">
            <div className="camera-mode">{cameraMode === 'single' ? '目前模式：單拍' : '目前模式：批拍'}</div>
            <video ref={videoRef} autoPlay playsInline muted />
          </div>
        )}

        {isProcessingImages && uploadProgress && uploadProgress.total > 0 && (
          <div className="progress-card">
            <div className="progress-text">
              <strong>
                {uploadProgress.mode === 'batch' ? '讀取檔案（批次）' : '讀取檔案（單張）'}{' '}
                {uploadProgress.current}/{uploadProgress.total}
              </strong>
              <span>{uploadProgress.currentFileName}</span>
            </div>
            <progress value={uploadProgress.current} max={uploadProgress.total} />
          </div>
        )}

        <div className="settings-grid">
          <label>
            頁面大小
            <select value={pdfPageSize} onChange={(event) => setPdfPageSize(event.target.value)}>
              {PDF_SIZE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            邊距
            <select value={pdfMarginPreset} onChange={(event) => setPdfMarginPreset(event.target.value)}>
              <option value="none">無邊距</option>
              <option value="normal">一般</option>
              <option value="wide">寬邊距</option>
            </select>
          </label>

          <label>
            PDF 品質
            <select value={pdfOutputQuality} onChange={(event) => setPdfOutputQuality(event.target.value)}>
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </label>

          <label>
            檔名
            <input
              type="text"
              value={pdfFileName}
              onChange={(event) => setPdfFileName(event.target.value)}
              placeholder="scanned-document"
            />
          </label>
        </div>

        <div className="settings-grid compression">
          <label>
            圖片長邊上限
            <input
              type="number"
              min={IMAGE_EDGE_MIN}
              max={IMAGE_EDGE_MAX}
              step="100"
              value={maxImageEdge}
              onChange={(event) => {
                const n = Number(event.target.value)
                if (!Number.isFinite(n)) return
                setMaxImageEdge(Math.min(IMAGE_EDGE_MAX, Math.max(IMAGE_EDGE_MIN, n)))
              }}
            />
          </label>

          <label>
            圖片壓縮品質
            <select
              value={imageCompressionQuality}
              onChange={(event) => setImageCompressionQuality(event.target.value)}
            >
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </label>
        </div>

        <div className="settings-flag">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fullOpenCvScan}
              onChange={(e) => setFullOpenCvScan(e.target.checked)}
            />
            <span>
              <strong>完整透視掃描</strong>（OpenCV 偵測紙張並拉平，較慢）。未勾選時為<strong>極速</strong>：只壓縮裁切區域、不做透視偵測，通常可快<strong>數倍～約十倍</strong>；桌面斜拍、邊緣不易裁準時再勾選。
            </span>
          </label>
        </div>

        <p className="import-pipeline-hint">
          <strong>流程：</strong>選圖或拍照後會先開<strong>裁切視窗</strong>，確認範圍並按「套用並掃描」；略過則不加入列表。預設<strong>極速</strong>（bitmap 長邊至多約 {INSTANT_PIPELINE_BITMAP_MAX_LONG_EDGE}
          px）；勾選完整掃描時至多約 {OPEN_CV_PIPELINE_BITMAP_MAX_LONG_EDGE}px 並跑透視／色階。
          支援常見圖檔與 HEIC；表單「圖片長邊上限」仍影響列表壓縮（約 {SCAN_PIPELINE_MIN_LONG_EDGE}～{SCAN_PIPELINE_CAP_LONG_EDGE}px）。
          <strong>PDF 以掃描結果</strong>嵌入（長邊上限 {PDF_EXPORT_MAX_LONG_EDGE}px）。
        </p>

        <div className="toolbar">
          <span>{imageCountLabel}</span>
          <button
            type="button"
            className="button primary"
            onClick={exportPdf}
            disabled={images.length === 0 || isExporting || isProcessingImages}
          >
            {isExporting ? '輸出中...' : '輸出 PDF'}
          </button>
        </div>
        {downloadNotice && (
          <div className="download-notice">
            <strong>下載提醒</strong>
            <span>若手機沒有自動下載，請點下方按鈕手動下載。</span>
            <button
              type="button"
              className="button primary"
              onClick={() => triggerDownload(downloadNotice.url, downloadNotice.fileName)}
            >
              下載 {downloadNotice.fileName}
            </button>
          </div>
        )}
        {errorMessage && <p className="error">{errorMessage}</p>}
      </section>

      <section className="card list">
        {images.length === 0 ? (
          <p className="empty">先上傳或拍一張，30 秒內完成第一份 PDF。</p>
        ) : (
          <ul>
            {images.map((image, index) => (
              <li key={image.id} className="image-item">
                <img src={image.src} alt={image.name} />
                <div className="meta">
                  <strong>{image.name}</strong>
                  <span>第 {index + 1} 頁</span>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setCropTargetId(image.id)}
                    disabled={importHead != null}
                    title={importHead ? '請先完成目前匯入的裁切／掃描' : undefined}
                  >
                    重新裁切並掃描
                  </button>
                  <button type="button" className="button ghost" onClick={() => moveImage(index, -1)}>
                    上移
                  </button>
                  <button type="button" className="button ghost" onClick={() => moveImage(index, 1)}>
                    下移
                  </button>
                  <button type="button" className="button danger" onClick={() => removeImage(image.id)}>
                    刪除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

export default ToolPage
