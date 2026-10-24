# 錄系統操作畫面

## 原則
- 被拍的系統只唯讀使用：用它自己的啟動腳本、展示環境、模擬資料介面；需要劇本化的資料（例：某位病人血壓慢慢下降）就餵它既有的模擬介面，不改它的程式。
- 先探查再寫錄影腳本：每一步截圖並列出畫面上的按鈕名稱（`aria-label` 或文字），錄影腳本用 `getByRole('button', { name })` 點，不用座標。
- 每次正式錄製前重建一份全新的資料（不然前一次試錄的求助、紀錄會出現在畫面上）。
- 全部用虛構資料；姓名用一般常見姓名比「測試甲」自然，但畫面上要有「展示資料皆為虛構」的標示（合成時加）。

## 錄法
- `createRecorder(page, { outDir })`：DevTools 協定 `Page.startScreencast` 逐格 JPEG，每格帶時間戳，`stop()` 依實際間隔組成固定 30fps 的 mp4，並寫同名 `.json`（起訖、格數、`mark()` 的標記點）。
- `tapMarks(page)`：點擊處出現淡出的圓點；在 `goto` 之前呼叫。
- `deviceScaleFactor: 1.5`：1280×800 的平板錄成 1920×1200，放大到全畫面也清楚。
- 兩個畫面要同步（例：病人端與護理端）：兩個 recorder 同時 `start()`，合成時以各自的 `start` 對齊。
- 系統有延遲送出的動作（例：8 秒內可復原才真的送出）時，錄影要等它送出，剪輯再把等待剪掉。

## Windows 上的坑
- Git Bash 會把 `/路徑` 參數改成 `C:/Program Files/Git/路徑`；加 `MSYS_NO_PATHCONV=1` 時，輸出路徑要寫成 `C:/...`，不要寫 `/c/...`（會變成 `C:\c\...`）。
- Playwright 用系統的 Chrome：`chromium.launch({ channel: 'chrome' })`，不必另外下載瀏覽器。
- 開發伺服器以背景執行時，收尾要照埠號找 PID、`taskkill /T /F`，不然 vite 與 ts-node 會留著佔埠。
