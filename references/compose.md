# 合成與混音

## HyperFrames
- 版本釘在 `video.json` 的 `hyperframes`（預設 0.8.143）；`npx hyperframes@<版本> init build/hf --example blank --non-interactive`。先 `npx hyperframes telemetry disable`。
- `init` 會順手把 HyperFrames 的 skill 裝到全域 `~/.claude/skills/`（hyperframes、hyperframes-cli、hyperframes-registry、media-use）；寫構圖前讀 `hyperframes` 那份的 Contract 與 `references/format.md`、`captions.md`。不想常駐就設 `HYPERFRAMES_SKIP_SKILLS=1`。
- 一鏡一個 sub-composition（`compositions/<鏡>.html`），根目錄只放各鏡的掛載點、錄好的影片、`build/mix.wav` 一條音軌。
- 錄好的操作影片：`<video muted playsinline>`，素材放 `assets/`；分割畫面時兩支影片用各自的 `data-media-start` 對齊。
- 中文字型：Noto Sans TC 等不在內建清單，要 `@font-face` 指到 `assets/fonts/` 裡的檔案。
- 每一句旁白的起點在 `build/narration.json`；字卡、標註在旁白念到時出現。
- 出處小字、「展示資料皆為虛構」標示放在 90% 安全框內；字幕放 80% 標題安全框內、離底 80～120 px。
- `npx hyperframes check --json` 全過、`snapshot --review` 看過再 `render`。

## 版面
- 裝置外框用 CSS 畫（圓角、深色邊、陰影），不放任何品牌的外觀。
- 分割畫面：平板 16:10 與護理站 16:9 並排，上下留白放一行說明（「病人的平板」「護理站」）。
- 被拍系統畫面上的小字看不清時，用放大框（局部放大 1.6～2 倍）帶到重點，不要整片縮放晃動。

## 混音（`fv mix`）
- 旁白各句照 `narration.json` 擺；音樂 `video.json` 的 `music.file`，`gainDb` 預設 -20，旁白出現時再以 sidechain 壓約 8 dB。
- 輸出 `build/mix.wav`（旁白＋音樂）與 `build/voice.wav`（只有旁白，給無旁白版以外的檢查用）。
- 無旁白版：同一個構圖把音軌換成只有音樂的版本，字幕保留。
- 音樂只用 CC0 或明確允許的授權，授權頁存一份在 `sources.md`。
