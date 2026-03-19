import { useEffect, useMemo, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import './App.css'

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

function App() {
  const [images, setImages] = useState([])
  const [isCameraOpen, setIsCameraOpen] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isProcessingImages, setIsProcessingImages] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [pdfPageSize, setPdfPageSize] = useState('a4')
  const [pdfMarginPreset, setPdfMarginPreset] = useState('normal')
  const [pdfOutputQuality, setPdfOutputQuality] = useState('medium')
  const [pdfFileName, setPdfFileName] = useState('scanned-document')
  const [maxImageEdge, setMaxImageEdge] = useState(2000)
  const [imageCompressionQuality, setImageCompressionQuality] = useState('medium')
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  const imageCountLabel = useMemo(() => {
    if (images.length === 0) return '尚未加入圖片'
    return `目前共 ${images.length} 張`
  }, [images])

  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])

  useEffect(() => {
    if (isCameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [isCameraOpen])

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error(`無法讀取檔案：${file.name}`))
      reader.readAsDataURL(file)
    })

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

  const getSafeFileName = (value) => {
    const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, '-')
    if (!normalized) return 'scanned-document.pdf'
    return normalized.toLowerCase().endsWith('.pdf') ? normalized : `${normalized}.pdf`
  }

  const stopCamera = () => {
    const stream = streamRef.current
    if (!stream) return
    stream.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const handleUpload = async (event) => {
    const files = Array.from(event.target.files || [])
    if (files.length === 0) return

    setErrorMessage('')
    setIsProcessingImages(true)
    try {
      const dataUrls = await Promise.all(files.map((file) => readFileAsDataUrl(file)))
      const compressedUrls = await Promise.all(
        dataUrls.map((url) => compressImage(url, maxImageEdge, imageCompressionQuality)),
      )
      const newImages = compressedUrls.map((url, index) => {
        const name = files[index]?.name?.replace(/\.[^.]+$/, '') || `upload-${index + 1}`
        return toImageItem(url, name)
      })
      setImages((prev) => [...prev, ...newImages])
    } catch (error) {
      setErrorMessage(error.message || '上傳失敗，請再試一次。')
    } finally {
      setIsProcessingImages(false)
      event.target.value = ''
    }
  }

  const startCamera = async () => {
    setErrorMessage('')
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
    } catch (error) {
      setErrorMessage('無法開啟相機，請確認權限或 HTTPS 環境。')
    }
  }

  const closeCamera = () => {
    setIsCameraOpen(false)
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
      const compressed = await compressImage(dataUrl, maxImageEdge, imageCompressionQuality)
      setImages((prev) => [...prev, toImageItem(compressed, `capture-${prev.length + 1}`)])
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

      pdf.save(getSafeFileName(pdfFileName))
    } catch (error) {
      setErrorMessage(error.message || 'PDF 產生失敗，請稍後再試。')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Photo to PDF</h1>
        <p>匯入照片或直接拍照，快速輸出成 PDF。</p>
      </header>

      <section className="card controls">
        <div className="button-group">
          <label className="button secondary">
            上傳圖片
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleUpload}
              disabled={isProcessingImages}
            />
          </label>

          {!isCameraOpen ? (
            <button
              type="button"
              className="button secondary"
              onClick={startCamera}
              disabled={isProcessingImages}
            >
              開啟相機
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button secondary"
                onClick={capturePhoto}
                disabled={isProcessingImages}
              >
                {isProcessingImages ? '處理中...' : '拍照'}
              </button>
              <button type="button" className="button ghost" onClick={closeCamera}>
                關閉相機
              </button>
            </>
          )}
        </div>

        {isCameraOpen && (
          <div className="camera-box">
            <video ref={videoRef} autoPlay playsInline muted />
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
        {errorMessage && <p className="error">{errorMessage}</p>}
      </section>

      <section className="card list">
        {images.length === 0 ? (
          <p className="empty">先上傳或拍一張照片，開始建立 PDF。</p>
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

export default App
