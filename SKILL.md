---
name: formal-video
description: 製作要交給別人看或在會議上播的正式影片（展示、簡報、成果、教學）：查證、寫稿、使用者聲音模型配音、錄系統操作畫面、合成、品質檢查。使用者說「做影片」「demo 影片」「剪片」「配旁白」或 /formal-video 時使用。
---

# formal-video

正式影片的流程與工具。核心原則：**畫面上每一句事實都查得到出處、每一步都有自動檢查、人只在開頭與審片出現**。

工具位置：本檔所在目錄（以下稱 `$FV`）。指令：`node $FV/bin/fv.mjs <子指令>`，第一次先跑 `doctor`。

## 全域規則
1. 影片專案放使用者指定的資料夾，**不放進被拍的那個專案**；被拍的系統只唯讀使用，執行時產生的資料錄完就清掉。
2. 人工介入一次問完：開場把決策、錄音、下載與公開推送的同意一起列出（`references/kickoff.md`），之後到審片前不再提問，自行判斷寫進專案的 `decisions.md`。
3. 數字與事實只用原始出處（`references/facts.md`）；查不到就不上片。
4. 用語照使用者的語言規範；台灣用語時 `fv lint` 會跑支語檢查。
5. 片中不能出現的事（例：經費）寫進 `video.json` 的 `bannedTerms`，由 lint 擋。

## 十個階段
| 階段 | 做什麼 | 完成條件 | 細節 |
|---|---|---|---|
| 0 brief | 觀眾、場合、要他們做的決定、時長、禁用詞、播放環境 | `brief.md`、`video.json` 填好 | `references/kickoff.md` |
| 1 論述 | 選結構（新創 demo／學術／產品），排分鏡 | 每一段對應一個觀眾在意的問題 | `references/narrative.md` |
| 2 查證 | 每個數字找原始出處，寫 `sources.md` | 每筆有網址、查詢日、原文摘錄 | `references/facts.md` |
| 3 稿 | `script.md` 旁白表與分鏡表 | `fv lint` 全過 | `references/narrative.md` |
| 4 聲音 | 切句對稿→微調→逐句合成→反聽 | 每句字錯率 ≤ 門檻；`fv timeline` 產生時間表 | `references/voice.md` |
| 5 錄製 | Playwright 照腳本操作，DevTools 協定逐格錄 | 每鏡長度蓋得住對應旁白 | `references/capture.md` |
| 6 合成 | HyperFrames：字卡、裝置外框、標註、出處、字幕 | `npx hyperframes check` 無錯 | `references/compose.md` |
| 7 混音 | `fv mix`：旁白＋音樂自動壓低 | — | `references/compose.md` |
| 8 檢查 | `fv qa`，看縮圖總表 | 全部 ✔ | `references/qa.md` |
| 9 交付 | `fv master` 出 1080p／720p、字幕檔、引用清單；工具缺陷回寫 repo | 審片意見處理完 | `references/qa.md` |

## 常用指令
- `fv init <dir>`：從 `templates/project/` 建骨架。
- `fv voice prep|train|say|asr`：語音，參數見 `references/voice.md`。
- `fv lint <dir>`、`fv timeline <dir>`、`fv mix <dir>`、`fv qa <mp4> --script <dir>`、`fv master <mp4> <輸出前綴>`。
- 錄製：影片專案自己裝 `playwright-core`，再 `import { createRecorder, tapMarks } from '$FV/lib/capture.mjs'`。
