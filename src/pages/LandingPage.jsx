import { Link } from 'react-router-dom'
import './LandingPage.css'

function LandingPage() {
  return (
    <main className="landing">
      <section className="hero">
        <p className="badge">免註冊・免費・隱私優先</p>
        <h1>3 秒把照片變 PDF</h1>
        <p className="subtitle">
          支援 iPhone HEIC、批次掃描、手機直接下載。所有圖片只在你的裝置本機處理，不上傳伺服器。
        </p>
        <div className="hero-actions">
          <Link className="cta primary" to="/tool">
            立即開始掃描
          </Link>
          <a className="cta ghost" href="#how-it-works">
            看 30 秒示範流程
          </a>
        </div>
      </section>

      <section className="value-grid">
        <article className="value-card">
          <h3>照片太多，整理太慢</h3>
          <p>上傳批次 / 相機批拍，快速建立頁面順序。</p>
        </article>
        <article className="value-card">
          <h3>iPhone HEIC 常不相容</h3>
          <p>自動轉換 HEIC/HEIF，免手動轉檔。</p>
        </article>
        <article className="value-card">
          <h3>手機下載常失敗</h3>
          <p>匯出後提供下載提醒與手動下載按鈕。</p>
        </article>
      </section>

      <section id="how-it-works" className="steps">
        <h2>三步驟完成</h2>
        <ol>
          <li>上傳或拍照</li>
          <li>調整順序與輸出設定</li>
          <li>一鍵下載 PDF</li>
        </ol>
      </section>

      <section className="proof">
        <h2>信任與隱私</h2>
        <p>100% 本機處理，不會上傳你的文件內容。</p>
      </section>

      <section className="faq">
        <h2>常見問題</h2>
        <div className="faq-list">
          <article>
            <h3>會上傳到雲端嗎？</h3>
            <p>不會，圖片在瀏覽器本機處理。</p>
          </article>
          <article>
            <h3>支援 HEIC 嗎？</h3>
            <p>支援，系統會自動轉成 JPEG 處理。</p>
          </article>
          <article>
            <h3>手機可以直接下載嗎？</h3>
            <p>可以，匯出後會跳下載提醒，沒自動下載也能手動再點一次。</p>
          </article>
        </div>
      </section>

      <section className="bottom-cta">
        <h2>準備好開始了嗎？</h2>
        <Link className="cta primary" to="/tool">
          立即開始掃描
        </Link>
      </section>
    </main>
  )
}

export default LandingPage
