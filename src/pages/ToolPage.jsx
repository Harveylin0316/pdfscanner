import { useEffect, useMemo, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import { autoCropByCornerBackground, enhanceDocumentScan } from '../lib/scanPreprocess.js'
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

const JPEG_QUALITY_PRESETS = {
  high: 0.92,
  medium: 0.8,
  low: 0.65,
}

const PDF_IMAGE_COMPRESSION = {
  high: 'FAST',
  medium: 'MEDIUM',
  low: 'SLOW',
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
  const [pdfOutputQuality, setPdfOutputQuality] = useState('medium')
  const [pdfFileName, setPdfFileName] = useState('scanned-document')
  const [maxImageEdge, setMaxImageEdge] = useState(2000)
  const [imageCompressionQuality, setImageCompressionQuality] = useState('medium')
  const [scanDocumentEnhance, setScanDocumentEnhance] = useState(true)
  const [scanAutoCrop, setScanAutoCrop] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const uploadSingleInputRef = useRef(null)
  const uploadBatchInputRef = useRef(null)

  const imageCountLabel = useMemo(() => {
    if (images.length === 0) return '尚未加入圖片'
    return `目前共 ${images.length} 張`
  }, [images])

  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])

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

  const readBlobAsDataUrl = (blob, fileName = 'image') =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error(`無法讀取檔案：${fileName}`))
      reader.readAsDataURL(blob)
    })

  const readFileAsDataUrl = (file) => readBlobAsDataUrl(file, file.name)

  const loadImage = (dataUrl) =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('圖片解析失敗'))
      img.src = dataUrl
    })

  const compressImage = async (dataUrl, maxEdge, qualityPreset) => {
    const image = await loadImage(dataUrl)
    const longestEdge = Math.max(image.width, image.height)
    const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))

    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)

    const quality = JPEG_QUALITY_PRESETS[qualityPreset] || JPEG_QUALITY_PRESETS.medium
    return canvas.toDataURL('image/jpeg', quality)
  }

  const toImageItem = (source, fileName = 'photo') => ({
    id: crypto.randomUUID(),
    src: source,
    name: `${fileName}.jpg`,
  })

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

  const convertHeicToJpegDataUrl = async (file) => {
    const tryHeicTo = async () => {
      const { heicTo } = await import('heic-to')
      const jpegBlob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 })
      if (!jpegBlob || jpegBlob.size === 0) throw new Error('heic-to empty')
      return readBlobAsDataUrl(jpegBlob, file.name)
    }

    const tryHeic2Any = async () => {
      const module = await import('heic2any')
      const heic2any = module.default
      const converted = await heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.95,
      })
      const jpegBlob = Array.isArray(converted) ? converted[0] : converted
      return readBlobAsDataUrl(jpegBlob, file.name)
    }

    const tryNativeBitmap = async () => {
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return canvas.toDataURL('image/jpeg', 0.92)
    }

    try {
      return await tryHeicTo()
    } catch {
      /* newer iOS HEIC often fails on heic2any; heic-to first */
    }
    try {
      return await tryHeic2Any()
    } catch {
      /* legacy fallback */
    }
    try {
      return await tryNativeBitmap()
    } catch {
      /* Safari may decode HEIC here */
    }

    throw new Error(
      `HEIC 無法解碼：${file.name}。建議到 iPhone「設定 → 相機 → 格式」改為「最佳相容性」，或先用「照片」分享成 JPG 再上傳。`,
    )
  }

  const applyScanPipeline = async (dataUrl) => {
    const q = JPEG_QUALITY_PRESETS[imageCompressionQuality] || JPEG_QUALITY_PRESETS.medium
    let url = dataUrl
    try {
      if (scanAutoCrop) {
        url = await autoCropByCornerBackground(url, q)
      }
      if (scanDocumentEnhance) {
        url = await enhanceDocumentScan(url, q)
      }
    } catch {
      return dataUrl
    }
    return url
  }

  const normalizeUploadFileToDataUrl = async (file) => {
    if (isHeicFile(file)) {
      return convertHeicToJpegDataUrl(file)
    }
    if (isLikelyImageFile(file)) {
      return readFileAsDataUrl(file)
    }
    throw new Error(`不支援的檔案格式：${file.name}`)
  }

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

  const notifyDownloadReady = async (fileName, url) => {
    if (!('Notification' in window)) return

    try {
      let permission = Notification.permission
      if (permission === 'default') {
        permission = await Notification.requestPermission()
      }
      if (permission !== 'granted') return

      const notification = new Notification('PDF 已準備好', {
        body: `點一下下載 ${fileName}`,
      })
      notification.onclick = () => {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch {
      // Ignore notification errors and keep in-page download notice as fallback.
    }
  }

  const stopCamera = () => {
    const stream = streamRef.current
    if (!stream) return
    stream.getTracks().forEach((track) => track.stop())
    streamRef.current = null
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
          const normalizedDataUrl = await normalizeUploadFileToDataUrl(file)
          const pipelineUrl = await applyScanPipeline(normalizedDataUrl)
          const compressedDataUrl = await compressImage(
            pipelineUrl,
            maxImageEdge,
            imageCompressionQuality,
          )
          const name = getFileBaseName(file.name) || `upload-${index + 1}`
          successItems.push(toImageItem(compressedDataUrl, name))
        } catch (error) {
          failItems.push(error)
        }
      }

      if (successItems.length > 0) {
        setImages((prev) => [...prev, ...successItems])
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
      event.target.value = ''
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

  const capturePhoto = async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0)
    setIsProcessingImages(true)
    setErrorMessage('')

    try {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95)
      const pipelineUrl = await applyScanPipeline(dataUrl)
      const compressed = await compressImage(pipelineUrl, maxImageEdge, imageCompressionQuality)
      setImages((prev) => [...prev, toImageItem(compressed, `capture-${prev.length + 1}`)])
      if (cameraMode === 'single') {
        closeCamera()
      }
    } catch (error) {
      setErrorMessage(error.message || '拍照處理失敗，請再試一次。')
    } finally {
      setIsProcessingImages(false)
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
        const exportSrc = await compressImage(image.src, 2800, pdfOutputQuality)
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
      await notifyDownloadReady(safeFileName, objectUrl)
    } catch (error) {
      setErrorMessage(error.message || 'PDF 產生失敗，請稍後再試。')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <main className="app">
      <header className="header">
        <h1>照片轉 PDF</h1>
        <p>上傳或拍照後，調整順序與輸出設定，一鍵匯出 PDF。</p>
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
                {uploadProgress.mode === 'batch' ? '批次匯入中' : '單張匯入中'} {uploadProgress.current}/
                {uploadProgress.total}
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
              min="800"
              max="4000"
              step="100"
              value={maxImageEdge}
              onChange={(event) => setMaxImageEdge(Number(event.target.value) || 2000)}
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

        <div className="scan-options">
          <p className="scan-options-title">掃描品質（匯入／拍照當下套用）</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={scanDocumentEnhance}
              onChange={(event) => setScanDocumentEnhance(event.target.checked)}
            />
            <span>文件加強（提高對比與可讀性）</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={scanAutoCrop}
              onChange={(event) => setScanAutoCrop(event.target.checked)}
            />
            <span>簡易自動裁切（從邊緣「桌面」推斷紙張範圍；白紙＋單色桌面較準）</span>
          </label>
          <p className="scan-hint">
            HEIC 已改用較新的解碼器優先處理；若仍失敗，請到 iPhone「設定 → 相機 → 格式」改為「最佳相容性」。
          </p>
        </div>

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
