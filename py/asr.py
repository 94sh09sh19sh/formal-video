"""語音辨識：一個音檔 → 每段的起訖時間與文字（JSON）。

用法：python asr.py <音檔> <輸出.json> [--model large-v3] [--lang zh]

whisper 的中文輸出常是簡體，這裡一律用 OpenCC 轉成台灣正體再寫出；
比對旁白時兩邊都會再正規化，所以轉換錯一兩個字不影響對時。
"""
import argparse
import json
import sys

from faster_whisper import WhisperModel
from opencc import OpenCC


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--prompt", default="以下是台灣華語的句子。", help="給辨識的提示詞，可放專有名詞")
    args = ap.parse_args()

    s2t = OpenCC("s2twp")
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        args.audio,
        language=args.lang,
        initial_prompt=s2t.convert(args.prompt),
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        word_timestamps=True,
        beam_size=5,
    )
    out = []
    for seg in segments:
        out.append(
            {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": s2t.convert(seg.text.strip()),
                "words": [
                    {"start": round(w.start, 3), "end": round(w.end, 3), "word": s2t.convert(w.word)}
                    for w in (seg.words or [])
                ],
            }
        )
        print(f"{seg.start:7.2f}-{seg.end:7.2f} {out[-1]['text']}", file=sys.stderr, flush=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "duration": info.duration, "segments": out}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
