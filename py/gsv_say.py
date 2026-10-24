"""GPT-SoVITS 逐句合成＋反聽檢查。

用法：python gsv_say.py <工作.json>

工作檔格式：
{
  "engine": "<GPT-SoVITS 目錄>",
  "version": "v2ProPlus",
  "sovits": "<sovits.pth，省略則用底模＝零樣本>",
  "gpt": "<gpt.ckpt，省略則用底模>",
  "ref_audio": "<3～10 秒參考音>", "ref_text": "<參考音念的字>",
  "out_dir": "<輸出目錄>",
  "asr_model": "large-v3", "max_cer": 0.05, "tries": 4, "speed": 1.0,
  "lines": [{"id": "L01", "text": "要念的字", "expect": "字幕上的字（比對用）"}]
}

每句最多試 tries 次（每次換 seed），取拼音錯率（不分聲調；同音字不算錯）最低的一次；寫出 <id>.wav 與 report.json
（每句的 seed、拼音錯率、字錯率、秒數、whisper 聽到什麼）。拼音錯率超過 max_cer 的句子在報告裡標 fail。
工作檔可加 "seed_base" 換一批 seed 重試。
"""
import json
import os
import sys
import time

import numpy as np
import soundfile as sf

from textnorm import cer, per


def main() -> None:
    job_path = os.path.abspath(sys.argv[1])
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)
    out_dir = os.path.abspath(job["out_dir"])
    os.makedirs(out_dir, exist_ok=True)
    engine = job["engine"]
    version = job.get("version", "v2ProPlus")
    ref_audio = os.path.abspath(job["ref_audio"])
    sovits = os.path.abspath(job["sovits"]) if job.get("sovits") else None
    gpt = os.path.abspath(job["gpt"]) if job.get("gpt") else None

    os.chdir(engine)
    sys.path.insert(0, engine)
    sys.path.insert(0, os.path.join(engine, "GPT_SoVITS"))
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config  # noqa: E402
    from faster_whisper import WhisperModel  # noqa: E402

    base = TTS_Config.default_configs[version]
    cfg = {
        "custom": {
            **base,
            "device": "cpu",
            "is_half": False,
            "version": version,
            "t2s_weights_path": gpt or base["t2s_weights_path"],
            "vits_weights_path": sovits or base["vits_weights_path"],
        }
    }
    tts = TTS(TTS_Config(cfg))
    asr = WhisperModel(job.get("asr_model", "large-v3"), device="cpu", compute_type="int8")
    max_cer = job.get("max_cer", 0.05)
    tries = job.get("tries", 4)

    # 只重做部分句子時，其餘句子沿用原本的報告
    report_path = os.path.join(out_dir, "report.json")
    previous = []
    if os.path.exists(report_path):
        with open(report_path, encoding="utf-8") as f:
            previous = json.load(f)
    redo = {line["id"] for line in job["lines"]}
    report = [r for r in previous if r["id"] not in redo]
    for line in job["lines"]:
        best = None
        for attempt in range(tries):
            seed = job.get("seed_base", 1000) + attempt * 7919
            t0 = time.time()
            chunks = []
            sr = 32000
            for sr, pcm in tts.run(
                {
                    "text": line["text"],
                    "text_lang": "zh",
                    "ref_audio_path": ref_audio,
                    "prompt_text": job["ref_text"],
                    "prompt_lang": "zh",
                    "top_k": 15,
                    "top_p": 1,
                    "temperature": 1,
                    "text_split_method": "cut5",
                    "batch_size": 1,
                    "speed_factor": job.get("speed", 1.0),
                    "seed": seed,
                    "parallel_infer": False,
                    "repetition_penalty": 1.35,
                }
            ):
                chunks.append(pcm)
            audio = np.concatenate(chunks)
            tmp = os.path.join(out_dir, f"{line['id']}.try{attempt}.wav")
            sf.write(tmp, audio, sr)
            segs, _ = asr.transcribe(tmp, language="zh", beam_size=5, vad_filter=False)
            heard = "".join(s.text for s in segs)
            score = per(line.get("expect", line["text"]), heard)
            char_cer = cer(line.get("expect", line["text"]), heard)
            took = time.time() - t0
            print(f"[fv] {line['id']} 第{attempt + 1}次 seed={seed} 拼音錯率={score:.3f} 字錯率={char_cer:.3f} {took:.0f}秒 聽到：{heard}", flush=True)
            if best is None or score < best["cer"]:
                if best:
                    os.remove(best["tmp"])
                best = {"seed": seed, "cer": score, "char_cer": char_cer, "heard": heard, "tmp": tmp, "seconds": len(audio) / sr}
            else:
                os.remove(tmp)
            if score <= max_cer:
                break
        final = os.path.join(out_dir, f"{line['id']}.wav")
        os.replace(best["tmp"], final)
        report.append(
            {
                "id": line["id"],
                "text": line["text"],
                "file": final,
                "seed": best["seed"],
                "per": round(best["cer"], 4),
                "cer": round(best["char_cer"], 4),
                "seconds": round(best["seconds"], 3),
                "heard": best["heard"],
                "status": "ok" if best["cer"] <= max_cer else "fail",
            }
        )
        report.sort(key=lambda r: r["id"])
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
    fails = [r["id"] for r in report if r["status"] == "fail"]
    print(f"[fv] 完成 {len(report)} 句；未過門檻：{', '.join(fails) or '無'}")


if __name__ == "__main__":
    main()
