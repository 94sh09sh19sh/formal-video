# 聲音

## 引擎
- GPT-SoVITS（MIT）v2ProPlus：1 分鐘以上錄音就能微調；只有 CPU 也能訓練與合成。裝在 `<engines>/engines/GPT-SoVITS`，Python 環境在 `<engines>/engines/gsv-venv`。
- 安裝（Windows、只有 CPU）：`uv venv --python 3.11`；`torch==2.7.1 torchaudio==2.7.1`（CPU index）；`engines/gpt-sovits/requirements-cpu.txt`；把 `engines/gpt-sovits/shim/jieba_fast` 複製進 site-packages（沒有 C++ 編譯器時 jieba_fast 裝不起來）；底模 `pretrained_models.zip`、`G2PWModel.zip`、`nltk_data.zip` 從上游 install 腳本裡的 Hugging Face 網址下載解壓。
- 不建議：預訓練權重限非商用或授權不明的引擎（fish-speech、F5-TTS、IndexTTS），正式影片可能被拿去對外用。

## 流程與指令
1. 轉檔：`ffmpeg -i x.m4a -ac 1 -ar 48000 x.wav`；用 `silencedetect=n=-45dB:d=0.6` 數停頓，數到 0 的那一版多半底噪太高，不收。
2. 辨識：`fv voice asr <wav> <out.json> --prompt "<專有名詞>"`（faster-whisper large-v3，CPU int8，3 分鐘音檔約 5 分鐘）。
3. 切句對稿：`fv voice prep --script <錄音稿.md> --take <wav> <asr.json> [--take ...] --out <聲音目錄>/dataset --say "稿上寫法=實際念法"`。字錯率 > 0.15 的不收；收下的再抽聽，句首被切掉或念錯字的從 `train.list` 刪掉。
4. 微調：`fv voice train --list <dataset>/train.list --wav-dir <dataset>/wavs --name <名> --out <聲音目錄>/model`。CPU（8 核）約：前處理 3 分鐘、SoVITS 每輪 3.3 分鐘 × 8、GPT 每輪約 1 分鐘 × 15，合計約 45 分鐘，一律背景執行（見 SKILL.md 全域規則 6）。
5. 合成：`fv narrate <專案> [--only L03,L05] [--seed N]`（直接讀 script.md）；每句最多試 `voice.tries` 個 seed，取 whisper 反聽「拼音錯率」最低的（同音字不算錯，念錯才算）；報告在 `audio/narration/report.json`，只重做部分句子時會合併。
6. 像不像本人：`fv voice sim --ref <本人錄音...> --test <合成...>`，跟 `--zero-shot` 的結果比，微調要明顯比較高（實測一例：微調 0.834、零樣本 0.768、本人錄音彼此 0.902）。
7. 參考音：3～10 秒、語氣跟想要的旁白一樣的句子（不要用問句或閒聊的那段）；參考音的文字要逐字正確。

## 念不準時
- 英文縮寫：`念法` 寫成「A I」「K T over V」。
- 數字：寫成國字念法（「一百一十二」），字幕仍用阿拉伯數字。
- 多音字或台灣讀音：換同音字只放在 `念法`，字幕照原文。
- 一句太長語氣會散：拆成兩句、中間停 0.3 秒。
- 換兩批 seed（`--seed`）還是同一個字念錯：改寫那個詞（換同義詞，或改用系統畫面上的正式名稱），記進專案的 `decisions.md`。

## 備案
- 模型念不好：使用者照定稿自己念一次，`auto-editor` 去靜音、`fv voice asr` 對字幕。
