# 📈 股票觀測站 (Stock Observation Station)

一個基於 Glassmorphism (玻璃擬態) 設計風格的輕量級即時金融觀測面板。支援**台美股**、**外匯**與**加密貨幣**的即時報價、K 線圖表及基本面數據分析。

![螢幕截圖範例](https://via.placeholder.com/800x450.png?text=Stock+Observation+Station+Screenshot) <!-- 建議日後可替換成實際的網頁截圖 -->

## ✨ 功能特色

- **🌍 跨市場支援**：支援輸入美股 (如 `AAPL`)、台股 (如 `2330`)、外匯 (如 `USDTWD`) 與主流加密貨幣 (如 `BTC`, `ETH`)。
- **📊 專業 K 線圖表**：整合 TradingView 的 Lightweight Charts，支援 1 分鐘至日 K 等多種週期切換。電腦版支援鍵盤 `+` / `-` 快速縮放，手機版支援手勢觸控縮放。
- **💼 深度基本面數據**：
  - **美股**：串接 Finnhub API，提供本益比、EPS、市值、殖利率、ROE、毛利率等完整基本面與估值風險數據。
  - **台股**：自動抓取台灣證交所/櫃買中心官方資料，並結合即時報價自動推算最新 EPS。
- **📋 智慧自選股清單**：
  - 支援 SortableJS **拖曳排序**。
  - 支援依代碼、名稱、價格、漲跌幅等多維度自動排序。
  - 透過 `localStorage` 狀態記憶，重新整理網頁也能保留清單與最後觀看標的。
- **⚡ 即時背景更新**：每 10 秒自動靜默刷新即時報價與 K 線資料。
- **📱 完美響應式設計**：針對電腦與手機分別優化排版與圖表互動體驗。

## 🛠️ 技術棧 (Tech Stack)

### 前端 (Frontend)
- **HTML5 / CSS3 / Vanilla JavaScript**
- **[Tailwind CSS](https://tailwindcss.com/)** (透過 CDN 載入) - 快速構建現代化 UI。
- **[Lightweight Charts](https://tradingview.github.io/lightweight-charts/)** - 高效能的輕量級金融圖表庫。
- **[SortableJS](https://sortablejs.github.io/Sortable/)** - 實現流暢的清單拖曳排序。

### 後端 / API 代理 (Backend / Proxy)
- **[Cloudflare Workers](https://workers.cloudflare.com/)** - 作為無伺服器 (Serverless) 中介層，用於解決 CORS 問題並隱藏第三方 API Keys。

## 📂 檔案結構

為了便於維護，專案已拆分為以下模組：

```text
📦 stock-observation-station
 ┣ 📜 index.html      # 網頁主結構 (HTML)
 ┣ 📜 styles.css      # 樣式表 (Glassmorphism UI 及 RWD 設定)
 ┣ 📜 app.js          # 前端核心邏輯 (圖表渲染、API 呼叫、狀態管理)
 ┣ 📜 worker.js       # Cloudflare Worker 後端代理腳本
 ┗ 📜 README.md       # 專案說明文件
