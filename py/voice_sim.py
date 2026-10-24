"""聲紋相似度：合成語音和本人錄音像不像（用 GPT-SoVITS 附的 ERes2NetV2 聲紋模型）。

用法：python voice_sim.py <引擎目錄> --ref <本人錄音...> --test <合成音檔...> [--json 輸出.json]

本人錄音取平均聲紋當基準，每個合成檔算與基準的餘弦相似度；另外算本人錄音彼此之間的相似度當「天花板」參考。
數字越接近天花板越像本人；同一套檢查拿微調模型與零樣本比，才知道微調有沒有用。
"""
import argparse
import json
import os
import sys

import librosa
import torch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("engine")
    ap.add_argument("--ref", nargs="+", required=True)
    ap.add_argument("--test", nargs="+", required=True)
    ap.add_argument("--json")
    args = ap.parse_args()
    refs = [os.path.abspath(p) for p in args.ref]
    tests = [os.path.abspath(p) for p in args.test]

    os.chdir(args.engine)
    sys.path.insert(0, os.path.join(args.engine, "GPT_SoVITS"))
    from sv import SV  # noqa: E402

    sv = SV("cpu", False)

    def emb(path: str) -> torch.Tensor:
        wav, _ = librosa.load(path, sr=16000)
        e = sv.compute_embedding3(torch.from_numpy(wav).unsqueeze(0))[0]
        return torch.nn.functional.normalize(e, dim=0)

    ref_embs = [emb(p) for p in refs]
    center = torch.nn.functional.normalize(torch.stack(ref_embs).mean(0), dim=0)
    # 天花板：每一段本人錄音與「其他本人錄音的平均」的相似度
    ceiling = []
    for i, e in enumerate(ref_embs):
        others = torch.stack([x for j, x in enumerate(ref_embs) if j != i]).mean(0)
        ceiling.append(float(e @ torch.nn.functional.normalize(others, dim=0)))
    rows = [{"file": os.path.basename(p), "similarity": round(float(emb(p) @ center), 4)} for p in tests]
    mean = sum(r["similarity"] for r in rows) / len(rows)
    result = {"ceiling": round(sum(ceiling) / len(ceiling), 4), "mean": round(mean, 4), "rows": rows}
    for r in rows:
        print(f"{r['file']}\t{r['similarity']:.3f}")
    print(f"[fv] 平均 {mean:.3f}；本人錄音彼此 {result['ceiling']:.3f}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
