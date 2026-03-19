# 照片轉 PDF（pdfscanner3）

瀏覽器內將圖片合併為 PDF：上傳／相機、HEIC 轉換、壓縮與輸出設定。圖片於**使用者裝置本機**處理。

## 開發

```bash
npm install
npm run dev
```

## 建置

```bash
npm run build
npm run preview
```

## 技術棧

- React 19 + Vite 8
- jsPDF、heic-to / heic2any（HEIC）
- Netlify：`netlify.toml`（含 `/tool` → `/` 301 與 SPA fallback）

## 文件

- [掃描品質與 HEIC 說明](./docs/SCAN_AND_HEIC.md)
