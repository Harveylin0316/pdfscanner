import { useEffect, useMemo, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import './App.css'

function App() {
  const [images, setImages] = useState([])
  const [isCameraOpen, setIsCameraOpen] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
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

  const toImageItem = (source, fileName = 'photo') => {
    const extension = source.startsWith('data:image/png') ? 'png' : 'jpg'
    return {
      id: crypto.randomUUID(),
      src: source,
      name: `${fileName}.${extension}`,
    }
  }

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error(`無法讀取檔案：${file.name}`))
      reader.readAsDataURL(file)
    })

  const getImageSize = (dataUrl) =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.width, height: img.height })
      img.onerror = () => reject(new Error('圖片解析失敗'))
      img.src = dataUrl
    })

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
    try {
      const dataUrls = await Promise.all(files.map((file) => readFileAsDataUrl(file)))
      const newImages = dataUrls.map((url, index) => {
        const name = files[index]?.name?.replace(/\.[^.]+$/, '') || `upload-${index + 1}`
        return toImageItem(url, name)
      })
      setImages((prev) => [...prev, ...newImages])
    } catch (error) {
      setErrorMessage(error.message || '上傳失敗，請再試一次。')
    } finally {
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

  const capturePhoto = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    setImages((prev) => [...prev, toImageItem(dataUrl, `capture-${prev.length + 1}`)])
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
        format: 'a4',
      })

      for (let index = 0; index < images.length; index += 1) {
        const image = images[index]
        const { width, height } = await getImageSize(image.src)
        const pageWidth = pdf.internal.pageSize.getWidth()
        const pageHeight = pdf.internal.pageSize.getHeight()

        const scale = Math.min(pageWidth / width, pageHeight / height)
        const renderWidth = width * scale
        const renderHeight = height * scale
        const x = (pageWidth - renderWidth) / 2
        const y = (pageHeight - renderHeight) / 2

        if (index > 0) {
          pdf.addPage()
        }
        const imageType = image.src.startsWith('data:image/png') ? 'PNG' : 'JPEG'
        pdf.addImage(image.src, imageType, x, y, renderWidth, renderHeight, undefined, 'FAST')
      }

      pdf.save('scanned-document.pdf')
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
            <input type="file" accept="image/*" multiple onChange={handleUpload} />
          </label>

          {!isCameraOpen ? (
            <button type="button" className="button secondary" onClick={startCamera}>
              開啟相機
            </button>
          ) : (
            <>
              <button type="button" className="button secondary" onClick={capturePhoto}>
                拍照
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

        <div className="toolbar">
          <span>{imageCountLabel}</span>
          <button
            type="button"
            className="button primary"
            onClick={exportPdf}
            disabled={images.length === 0 || isExporting}
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
