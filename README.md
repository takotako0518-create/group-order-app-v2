# 小聚餐 · 點餐台

一個給朋友／同事聚餐用的共用點餐工具。每次約在不同餐廳，只要把餐廳資訊、菜單換掉，就能重複使用同一個網站；大家用同一個網址，用暱稱登入後就能各自點餐，最後自動幫忙算好每桌、每人的金額。

---

## 功能特色 / 使用方式

**給揪團主辦人（聚餐設定）**
- 設定餐廳名稱、服務費％、每人低消金額與備註、官方菜單網址、公告事項
- 菜單可以手動新增，也可以整段文字批次貼上（一行一項，只要有品名跟金額即可，中間格式不拘：空格、`$`、`|`、逗號都可以，例如從別的地方複製來的菜單文字也大多能直接貼上用）
- **AI 智慧讀取菜單**：上傳菜單 PDF 或照片，自動辨識品名與價格；頁數多的 PDF 會自動拆成小份分批處理再合併結果，也能手動指定只辨識某幾頁、或針對辨識失敗的頁面單獨重試
- 新增菜色時若名稱重複，會先提示、讓你選擇是否要跳過
- 菜單項目可以上下移動調整顯示順序，也支援勾選多筆一次刪除
- 桌次數量、每桌人數上限可自由增減

**給參加聚餐的人（點餐）**
- 不用註冊，輸入暱稱即可開始點餐；如果同一個暱稱之前點過餐，會自動接續到上次的桌次與點餐紀錄，不用重新選桌
- 選擇自己坐哪一桌，點選菜色即可加入，同一道菜點兩次會自動累加數量
- 如果同桌已經有別人點過同一道菜，會先提示確認，避免重複加成一份卻不知道
- 服務費、低消金額會用醒目的印章樣式徽章顯示在畫面右上角

**桌次總覽 / 結算總表**
- 每桌顯示成一張收據樣式的卡片：誰點了什麼、數量、小計、服務費、本桌合計
- 可以整筆刪除某人在該桌的所有點餐（有二次確認，避免手滑）
- 結算總表列出全場小計、服務費、總金額，以及各桌、各人的小計；未達低消會特別標示

**資料共享**
- 所有使用同一個網址的人看到的是同一份資料，會自動每 6 秒同步一次
- 換下一場聚餐時，直接進「聚餐設定」把資料覆蓋成新的即可，不需要重新部署網站

---

## 部署方式（免費、不需要寫程式）

整體架構是 **Netlify 靜態網站 + 兩個小後端（Netlify Functions）+ Netlify Blobs 共用資料庫**，全程都在網頁上點按鈕操作，不需要用到 git 指令。

### 需要準備的東西
- 一個 GitHub 帳號（免費，用來放程式碼）
- 一個 Netlify 帳號（免費，用 GitHub 帳號登入即可）
- 一個 Google AI Studio API Key（免費、不需信用卡，給 AI 讀菜單功能用）

### 步驟
1. **上傳程式碼到 GitHub**：在 GitHub 建一個新 repository，把這個資料夾裡的所有檔案拖曳上傳、Commit。
2. **申請 Gemini API Key**：到 [aistudio.google.com](https://aistudio.google.com) → 「Get API key」→「Create API key」，複製起來備用。
3. **Netlify 連接並部署**：到 [netlify.com](https://www.netlify.com) 用 GitHub 登入 →「Add new site」→「Import an existing project」→ 選 GitHub → 選你剛建立的 repository → 直接「Deploy site」（build 設定已經寫在 `netlify.toml` 裡，不用手動填）。
4. **設定環境變數**：部署完成後，到「Site configuration」→「Environment variables」→ 新增一筆 Key 為 `GEMINI_API_KEY`、Value 為步驟 2 的金鑰 → 存檔後回「Deploys」頁籤按「Trigger deploy」重新部署一次（環境變數要重新部署才會生效）。

完成後就會拿到一個 `xxx.netlify.app` 的網址，可以分享給大家使用。

### 之後要更新程式碼
直接在 GitHub 網頁上編輯檔案，或把改好的檔案拖上去覆蓋、Commit，Netlify 偵測到新的 commit 會自動重新部署，不需要手動操作。

---

## 技術架構

```
使用者瀏覽器（React）
   │
   ├─ 讀寫聚餐資料 ──▶ Netlify Function（storage.js）──▶ Netlify Blobs（共用資料庫）
   │
   └─ AI 讀菜單請求 ──▶ Netlify Edge Function（extract-menu.js）──▶ Google Gemini API
```

- **前端**：React + Vite，純樣式用 inline style 撰寫（沒有用 CSS 框架），圖示用 `lucide-react`。
- **共用資料庫**：用 [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) 存放餐廳設定、菜單、桌次、點餐紀錄，透過一個 Netlify Function 讀寫，所有訪客共用同一份。
- **AI 讀菜單**：瀏覽器端用 `pdf-lib` 把大 PDF 自動拆成每 6 頁一份的小檔案，依序（間隔約 1.3 秒，避免觸發免費額度的速率限制）送到一個 Netlify **Edge Function**，由後端帶著 API Key 呼叫 Google Gemini API（`gemini-3.5-flash`），辨識結果原封不動傳回瀏覽器合併。用 Edge Function 而非一般 Function，是因為它能接受的請求大小與執行時間限制寬鬆很多，適合處理較大的 PDF。
- **為什麼是 ES Module**：專案的 `package.json` 設定了 `"type": "module"`，所以所有的 Netlify Functions／Edge Functions 都要用 `import`/`export` 的 ES Module 語法撰寫，不能用 `require`/`exports.handler` 的 CommonJS 語法（混用會導致 Function 直接崩潰）。
- **金鑰安全性**：`GEMINI_API_KEY` 只存在 Netlify 後端的環境變數裡，瀏覽器端完全不會接觸到，不會外流。
- **多人同步**：沒有做即時推播，是用每 6 秒輪詢（polling）的方式讓所有裝置的資料保持接近同步；本地剛存檔後的 9 秒內會暫停輪詢，避免因為後端資料庫短暫的同步延遲，讓畫面出現「剛存的東西閃一下又消失」的狀況。

---

## 專案結構

```
site/
├── index.html                        Vite 進入點
├── package.json                      依賴套件與 build 指令
├── vite.config.js                    Vite 設定（React 外掛）
├── netlify.toml                      Netlify 的 build／發布設定
│
├── src/
│   ├── main.jsx                      React 進入點，掛載 App 並安裝 storage 相容層
│   ├── App.jsx                       主要畫面與邏輯（點餐、桌次、結算、設定、AI 讀菜單）
│   └── storageClient.js              把讀寫資料的呼叫轉發到 storage.js 這個 Function
│
└── netlify/
    ├── functions/
    │   └── storage.js                共用資料庫的讀寫 API（get/set/delete/list），基於 Netlify Blobs
    └── edge-functions/
        └── extract-menu.js           AI 讀菜單的中介伺服器，代為呼叫 Google Gemini API
```

---

## 已知限制

- 免費方案下，多人同步是每 6 秒輪詢一次，不是即時推播，偶爾切換頁面時會有幾秒的延遲。
- Netlify Blobs 是最終一致性（eventually consistent）的儲存，極少數情況下（例如短時間內大量操作）畫面可能會短暫顯示到還沒更新的資料，重新整理一次就會恢復正常。
- AI 讀菜單依賴 Google Gemini 的免費額度，短時間內大量測試可能會碰到速率限制；畫面上會顯示明確的錯誤原因方便判斷。
- 目前沒有帳號權限機制，任何拿到網址的人都可以修改「聚餐設定」，適合信任度高的小型聚會使用，不建議用在需要嚴格權限控管的場合。
