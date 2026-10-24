"""把整段錄音切成一句一檔，並對到錄音稿，產生 GPT-SoVITS 的訓練清單。

用法：
  python voice_prep.py --script <錄音稿.md> --take <音檔.wav> <辨識.json> [--take ...]
      --out <輸出目錄> [--say "Kt/V=K T over V"] [--max-cer 0.15] [--speaker me]

- 錄音稿：抓「數字. 句子」格式的列。
- 辨識檔由 asr.py 產生（要有逐字時間）。
- 同一句念了兩次（念錯重念）時取比較接近原稿的那一次；分數相同取後念的。
- --say 是「稿上寫法=實際念法」，訓練標註用實際念法（例：Kt/V 念成 K T over V）。
- 字錯率超過 --max-cer 的句子不收（多半是念錯或沒念），寫在 prep.json 的 dropped。
輸出：<out>/wavs/<take>_<句號>.wav、<out>/train.list、<out>/prep.json
"""
import argparse
import json
import os
import re
import subprocess

from textnorm import cer, norm


def read_lines(path: str) -> list[str]:
    lines = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            m = re.match(r"^\s*(\d+)\.\s+(.+?)\s*$", raw)
            if m:
                lines.append(m.group(2))
    return lines


def words_of(asr_path: str) -> list[dict]:
    with open(asr_path, encoding="utf-8") as f:
        data = json.load(f)
    out = []
    for seg in data["segments"]:
        for w in seg["words"]:
            if norm(w["word"]):
                out.append(w)
    return out


def best_window(words: list[dict], start: int, target: str, search: int) -> list[tuple[float, int, int]]:
    """在 words[start:start+search] 裡找所有像 target 的連續區段，回傳 (字錯率, i, j)。"""
    n = len(norm(target))
    found = []
    for i in range(start, min(len(words), start + search)):
        acc = ""
        for j in range(i, len(words)):
            acc += norm(words[j]["word"])
            if len(acc) > n * 1.4 + 2:
                break
            if len(acc) >= n * 0.6:
                found.append((cer(target, acc), i, j + 1))
    return found


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--take", nargs=2, action="append", metavar=("WAV", "ASR"), required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--say", action="append", default=[])
    ap.add_argument("--max-cer", type=float, default=0.15)
    ap.add_argument("--speaker", default="me")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args()

    script = read_lines(args.script)
    say = dict(item.split("=", 1) for item in args.say)

    def spoken(text: str) -> str:
        for k, v in say.items():
            text = text.replace(k, v)
        return text

    wav_dir = os.path.join(args.out, "wavs")
    os.makedirs(wav_dir, exist_ok=True)
    kept, dropped, listing = [], [], []
    for wav, asr in args.take:
        take = os.path.splitext(os.path.basename(wav))[0]
        words = words_of(asr)
        ptr = 0
        for k, line in enumerate(script, 1):
            target = spoken(line)
            cands = best_window(words, ptr, target, search=len(norm(target)) * 3 + 20)
            if not cands:
                dropped.append({"take": take, "line": k, "reason": "找不到"})
                continue
            low = min(c[0] for c in cands)
            # 念錯重念：取分數夠接近最佳的最後一次
            score, i, j = max((c for c in cands if c[0] <= low + 0.02), key=lambda c: c[1])
            heard = "".join(w["word"] for w in words[i:j])
            ptr = j
            if score > args.max_cer:
                dropped.append({"take": take, "line": k, "cer": round(score, 3), "heard": heard})
                continue
            # whisper 的逐字時間常把第一個字切晚：往前多留 0.35 秒，但不超過與前一個字的中點
            prev_end = words[i - 1]["end"] if i > 0 else 0.0
            next_start = words[j]["start"] if j < len(words) else words[j - 1]["end"] + 1.0
            t0 = max(0.0, words[i]["start"] - 0.35, (prev_end + words[i]["start"]) / 2)
            t1 = min(words[j - 1]["end"] + 0.35, (words[j - 1]["end"] + next_start) / 2)
            name = f"{take}_{k:02d}.wav"
            subprocess.run(
                [args.ffmpeg, "-v", "error", "-y", "-i", wav, "-ss", f"{t0:.3f}", "-to", f"{t1:.3f}",
                 "-ac", "1", "-ar", "32000", "-af", "afade=t=in:d=0.02,areverse,afade=t=in:d=0.04,areverse",
                 os.path.join(wav_dir, name)],
                check=True,
            )
            listing.append(f"{name}|{args.speaker}|zh|{target}")
            kept.append({"take": take, "line": k, "file": name, "start": round(t0, 3), "end": round(t1, 3),
                         "seconds": round(t1 - t0, 3), "cer": round(score, 3), "heard": heard, "label": target})
    with open(os.path.join(args.out, "train.list"), "w", encoding="utf-8") as f:
        f.write("\n".join(listing) + "\n")
    with open(os.path.join(args.out, "prep.json"), "w", encoding="utf-8") as f:
        json.dump({"kept": kept, "dropped": dropped}, f, ensure_ascii=False, indent=1)
    total = sum(item["seconds"] for item in kept)
    print(f"[fv] 收 {len(kept)} 句（{total:.0f} 秒），不收 {len(dropped)} 句")
    for d in dropped:
        print(f"[fv]   不收：{d}")


if __name__ == "__main__":
    main()
