# formal-video

正式影片（展示、簡報、成果、教學）的製作流程與工具，給 Claude Code 當 skill 用：查證、寫稿、使用者自己的聲音模型配音、錄系統操作畫面、HTML 合成、品質檢查、交付。

## 摘要
- 流程寫在 `SKILL.md`（十個階段、每階段的完成條件），細節在 `references/`。
- `bin/fv.mjs`：環境檢查、建專案、旁白 lint（長度、禁用詞、支語、標點、數字要有出處）、旁白時間表（whisper 逐字對稿）與字幕、混音、品質檢查、響度標準化輸出。
- `lib/capture.mjs`：用 DevTools 協定逐格錄網頁操作；游標先滑過去、按壓、再點下去（觀眾先看到點擊才換畫面）；錄影時鐘讓每個動作照旁白時間發生；瀏覽器時間平移（`lib/clock-shim.cjs` 給後端用）。
- `lib/narration.mjs`：查「某句念到某個詞」的時間，錄影與合成共用。
- `lib/hf.mjs`：HyperFrames 構圖零件：裝置外框裡的錄影、粗框聚光的標註與動畫、標註跨過畫面切換的檢查。
- `py/`：faster-whisper 辨識、錄音切句對稿、GPT-SoVITS 微調與逐句合成（反聽字錯率自動重試）。
- 合成用 HyperFrames（Apache-2.0）；聲音用 GPT-SoVITS（MIT）；辨識用 faster-whisper（MIT）；剪接用 FFmpeg。

## 為什麼這樣選
| 用途 | 採用 | 不採用 |
|---|---|---|
| 合成與輸出 | HyperFrames：HTML 寫畫面、逐格算圖、為 agent 設計 | Remotion：營利組織超過 3 人要買公司授權；Motion Canvas：輸出依賴編輯器介面 |
| 錄操作畫面 | Playwright＋DevTools screencast：清楚、可重跑 | Playwright 內建錄影畫質低；OBS 要人手操作 |
| 聲音複製 | GPT-SoVITS：1 分鐘錄音可微調、CPU 也能跑、MIT | fish-speech、F5-TTS 預訓練權重限非商用；IndexTTS 授權待審 |

## 安裝
1. Node.js 22 以上、Chrome。
2. 大型引擎放 `%LOCALAPPDATA%\formal-video\`（其他系統 `~/.local/share/formal-video/`），路徑可用 `config.local.json` 的 `engines` 改：
   - `ffmpeg/<版本>/bin/ffmpeg`（Windows 用 BtbN 的 GPL 編譯版）
   - `engines/GPT-SoVITS`（git clone 上游）、`engines/gsv-venv`（安裝步驟見 `references/voice.md`）
   - `hf-cache/`（whisper 模型第一次用時自動下載）
3. `node bin/fv.mjs doctor` 全部打勾。
4. 建議一起裝 [cache-guard](https://github.com/94sh09sh19sh/cache-guard)：訓練、算圖這類超過 1 小時的背景工作，等待期間由它保溫，回來接結果時不用整段重寫快取。

## 設定
- `config.local.json`（執行端，不進 repo）：`engines`、`ffmpeg`、`hyperframes`（版本）。
- 每支影片的設定在專案的 `video.json`（`templates/project/video.json` 有全部欄位）。

## 已知限制
- 中文字幕切行用標點與字數，不做斷詞；長句請在稿裡先拆好（「｜」）。
- 逐字時間靠 whisper 辨識合成語音再對稿；辨識和稿子差很多的句子會印警告，那幾句的時間是內插的。
- CPU 訓練聲音模型約 40 分鐘（8 核、5 分鐘錄音）。
- `capture.mjs` 不直接依賴 Playwright：影片專案自己裝 `playwright-core`，把 page 傳進來。
