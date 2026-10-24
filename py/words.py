"""逐字時間：一批旁白音檔 → 每個檔的辨識結果（含每個詞的起訖），給 fv timeline 對齊稿子用。

用法：python words.py <job.json>
job.json：{ "model": "large-v3", "prompt": "...", "items": [{ "wav": "...", "out": "....words.json" }] }

輸出已經比音檔新的就跳過（改了某一句重新合成，只會重跑那一句）。
whisper 的中文常是簡體，一律用 OpenCC 轉台灣正體；對齊時同音字對不上的地方由前後對得上的字內插。
"""
import json
import os
import sys

from faster_whisper import WhisperModel
from opencc import OpenCC


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)
    todo = [it for it in job["items"] if not (os.path.exists(it["out"]) and os.path.getmtime(it["out"]) >= os.path.getmtime(it["wav"]))]
    if not todo:
        print("[fv] 逐字時間都是最新的", file=sys.stderr)
        return
    s2t = OpenCC("s2twp")
    model = WhisperModel(job.get("model", "large-v3"), device="cpu", compute_type="int8")
    for it in todo:
        segments, _ = model.transcribe(
            it["wav"],
            language="zh",
            initial_prompt=s2t.convert(it.get("prompt") or job.get("prompt") or "以下是台灣華語的句子。"),
            word_timestamps=True,
            beam_size=5,
        )
        words = []
        for seg in segments:
            for w in seg.words or []:
                words.append({"s": round(w.start, 3), "e": round(w.end, 3), "w": s2t.convert(w.word.strip())})
        with open(it["out"], "w", encoding="utf-8") as f:
            json.dump({"words": words}, f, ensure_ascii=False)
        print(f"[fv] {os.path.basename(it['wav'])}：{''.join(w['w'] for w in words)}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
