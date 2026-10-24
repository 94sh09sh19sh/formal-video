# 合成與混音

## HyperFrames
- 版本釘在 `video.json` 的 `hyperframes`（預設 0.8.143）；`npx hyperframes@<版本> init build/hf --example blank --non-interactive`。先 `npx hyperframes telemetry disable`。
- `init` 會順手把 HyperFrames 的 skill 裝到全域 `~/.claude/skills/`（hyperframes、hyperframes-cli、hyperframes-registry、media-use）；寫構圖前讀 `hyperframes` 那份的 Contract 與 `references/format.md`、`captions.md`。不想常駐就設 `HYPERFRAMES_SKIP_SKILLS=1`。
- 一鏡一個 sub-composition（`compositions/<鏡>.html`），根目錄只放各鏡的掛載點、錄好的影片、`build/mix.wav` 一條音軌。
- 共用零件在 `lib/hf.mjs`：`screenClip`（裝置外框裡的錄影）、`callout`／`calloutIn`／`calloutOut`（標註）、`checkCallouts`、`anim`。時間一律從 `lib/narration.mjs` 查，不手填秒數。
- 錄好的操作影片：`<video muted playsinline>`，素材放 `assets/`；分割畫面時兩支影片用各自的 `data-media-start` 對齊。
- 中文字型：Noto Sans TC 等不在內建清單，要 `@font-face` 指到 `assets/fonts/` 裡的檔案。
- 出處小字、「展示資料皆為虛構」標示放在 90% 安全框內；字幕放 80% 標題安全框內、離底 80～120 px。
- `npx hyperframes check --json` 全過、`snapshot --review` 看過再 `render`。

## 對時
- 場景切點、字卡、標註都用 `N.at(句, 詞)`：旁白念到「送出」時畫面正在送出，念到某個功能的名稱時畫面正是那個功能。
- 錄影照旁白時間錄好（`references/capture.md`），合成時一鏡錄影從頭連續播；**不在一段錄影中間跳接來湊旁白**。
- 版面切換（例：分割畫面 → 護理站全畫面）放在錄影裡那次點擊的 `click` 前後 0.3 秒內，不要讓觀眾在小畫面裡看到跳頁、再切到大畫面看結果。
- 功能介紹段（例：三個小遊戲）：每個功能一句旁白、一段畫面，畫面在旁白念到名稱的那一刻切換，名稱標籤同時出現；一段至少 5 秒，讓觀眾看得到「做了什麼、得到什麼」。

## 標註
- 用 `callout()`：7 px 暖色粗框＋白色內外框＋光暈；出現時框外變暗（聚光）、框從大縮到位、脈動兩下；可帶 2～6 字的標籤說「看這裡的什麼」（例：「血壓變化」）。細框、沒有動畫的框觀眾會忽略。
- 旁白念到時出現；同一時間只一個聚光（第二個框 `dim: false`）。
- 畫面要換之前先收掉：用 `checkCallouts` 檢查每個框顯示期間，錄影裡沒有任何點擊生效（`click`）或 `kind: 'change'` 的標記；有就讓構圖腳本直接失敗。
- 被拍系統畫面上的小字看不清時，用不動的放大（`zoom`，1.3～1.6 倍）帶到重點，確認整塊重點都在畫面內、沒有被切掉一邊；不要整片縮放晃動。

## 版面
- 裝置外框用 CSS 畫（圓角、深色邊、陰影），不放任何品牌的外觀。
- 分割畫面：平板 16:10 與護理站 16:9 並排，上下留白放一行說明（「病人的平板」「護理站」）。
- 每一鏡要回答「這一鏡要觀眾看到什麼」；說不出來的鏡頭（例：捲到一半、上面一個空輸入框）就重錄或拿掉。

## 混音（`fv mix`）
- 旁白各句照 `narration.json` 擺；音樂 `video.json` 的 `music.file`，`gainDb` 預設 -20，旁白出現時再以 sidechain 壓約 8 dB。
- 輸出 `build/mix.wav`（旁白＋音樂）與 `build/voice.wav`（只有旁白，給無旁白版以外的檢查用）。
- 無旁白版：同一個構圖把音軌換成只有音樂的版本、不放字幕。
- 音樂只用 CC0 或明確允許的授權，授權頁存一份在 `sources.md`。
