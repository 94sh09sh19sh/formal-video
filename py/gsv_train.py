"""GPT-SoVITS 微調：照上游 webui.py「1abc 前處理 → SoVITS 訓練 → GPT 訓練」的同一套步驟，不開網頁介面。

用法（任何目錄都可以執行，腳本會切到引擎目錄）：
  python gsv_train.py --engine <GPT-SoVITS 目錄> --list <清單> --wav-dir <切好的音檔目錄> --name <實驗名>
      [--version v2ProPlus] [--sovits-epochs 8] [--gpt-epochs 15] [--batch 4] --out <模型輸出目錄>

清單一行一句：`檔名|說話者|zh|文字`（與上游的標註格式相同）。
訓練完把最後一輪的 SoVITS（.pth）與 GPT（.ckpt）複製到 --out，並寫 model.json 記下版本與參數。
CPU 也能跑，只是慢；每一步都把上游的輸出原樣印出來，方便看卡在哪。
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time

import yaml

PRETRAINED_S2G = {
    "v2Pro": "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth",
    "v2ProPlus": "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth",
}
PRETRAINED_S2D = {
    "v2Pro": "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2Pro.pth",
    "v2ProPlus": "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2ProPlus.pth",
}
PRETRAINED_S1 = "GPT_SoVITS/pretrained_models/s1v3.ckpt"
BERT = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
HUBERT = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
SV = "GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt"


def run(script: str, env: dict, args: list | None = None) -> None:
    cmd = [sys.executable, "-s", script, *(args or [])]
    print(f"\n[fv] {' '.join(cmd)}", flush=True)
    t0 = time.time()
    proc = subprocess.run(cmd, env={**os.environ, **env})
    if proc.returncode != 0:
        raise SystemExit(f"[fv] {script} 失敗（結束碼 {proc.returncode}）")
    print(f"[fv] {script} 完成，{time.time() - t0:.0f} 秒", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--list", required=True)
    ap.add_argument("--wav-dir", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--version", default="v2ProPlus", choices=sorted(PRETRAINED_S2G))
    ap.add_argument("--sovits-epochs", type=int, default=8)
    ap.add_argument("--gpt-epochs", type=int, default=15)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--skip-prep", action="store_true", help="前處理已做過時跳過")
    args = ap.parse_args()

    list_path = os.path.abspath(args.list)
    wav_dir = os.path.abspath(args.wav_dir)
    out_dir = os.path.abspath(args.out)
    os.chdir(args.engine)
    exp_dir = f"logs/{args.name}"
    os.makedirs(exp_dir, exist_ok=True)
    os.makedirs("TEMP", exist_ok=True)
    common = {
        "version": args.version,
        "is_half": "False",
        "_CUDA_VISIBLE_DEVICES": "0",
        "i_part": "0",
        "all_parts": "1",
        "inp_text": list_path,
        "inp_wav_dir": wav_dir,
        "exp_name": args.name,
        "opt_dir": exp_dir,
        "KMP_DUPLICATE_LIB_OK": "TRUE",
        "PYTHONIOENCODING": "utf-8",
        # 上游的前處理與訓練程式以「引擎根目錄」與「GPT_SoVITS」兩層為匯入起點
        "PYTHONPATH": os.pathsep.join([os.getcwd(), os.path.join(os.getcwd(), "GPT_SoVITS")]),
    }
    s2_config_path = f"GPT_SoVITS/configs/s2{args.version}.json"

    if not args.skip_prep:
        # 1a：文字 → 音素與 BERT 特徵
        run("GPT_SoVITS/prepare_datasets/1-get-text.py", {**common, "bert_pretrained_dir": BERT})
        part = f"{exp_dir}/2-name2text-0.txt"
        shutil.move(part, f"{exp_dir}/2-name2text.txt")
        # 1b：音檔 → HuBERT 特徵與 32k 音檔；Pro 版另抽聲紋
        run("GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py", {**common, "cnhubert_base_dir": HUBERT, "sv_path": SV})
        run("GPT_SoVITS/prepare_datasets/2-get-sv.py", {**common, "cnhubert_base_dir": HUBERT, "sv_path": SV})
        # 1c：語意 token
        run(
            "GPT_SoVITS/prepare_datasets/3-get-semantic.py",
            {**common, "pretrained_s2G": PRETRAINED_S2G[args.version], "s2config_path": s2_config_path},
        )
        with open(f"{exp_dir}/6-name2semantic-0.tsv", encoding="utf8") as f:
            body = f.read().strip("\n")
        with open(f"{exp_dir}/6-name2semantic.tsv", "w", encoding="utf8") as f:
            f.write("item_name\tsemantic_audio\n" + body + "\n")
        os.remove(f"{exp_dir}/6-name2semantic-0.tsv")

    # SoVITS 訓練（webui 的 open1Ba，CPU 時關 fp16、batch 照給的值）
    with open(s2_config_path, encoding="utf8") as f:
        s2 = json.load(f)
    s2_weight_dir = f"SoVITS_weights_{args.version}"
    os.makedirs(s2_weight_dir, exist_ok=True)
    os.makedirs(f"{exp_dir}/logs_s2_{args.version}", exist_ok=True)
    s2["train"].update(
        {
            "fp16_run": False,
            "batch_size": args.batch,
            "epochs": args.sovits_epochs,
            "text_low_lr_rate": 0.4,
            "pretrained_s2G": PRETRAINED_S2G[args.version],
            "pretrained_s2D": PRETRAINED_S2D[args.version],
            "if_save_latest": True,
            "if_save_every_weights": True,
            "save_every_epoch": args.sovits_epochs,
            "gpu_numbers": "0",
            "grad_ckpt": False,
            "lora_rank": 32,
        }
    )
    s2["model"]["version"] = args.version
    s2["data"]["exp_dir"] = s2["s2_ckpt_dir"] = exp_dir
    s2["save_weight_dir"] = s2_weight_dir
    s2["name"] = args.name
    s2["version"] = args.version
    s2_tmp = "TEMP/fv_s2.json"
    with open(s2_tmp, "w", encoding="utf8") as f:
        json.dump(s2, f)
    run("GPT_SoVITS/s2_train.py", common, ["--config", s2_tmp])

    # GPT 訓練（webui 的 open1Bb）
    with open("GPT_SoVITS/configs/s1longer-v2.yaml", encoding="utf8") as f:
        s1 = yaml.load(f, Loader=yaml.FullLoader)
    s1_weight_dir = f"GPT_weights_{args.version}"
    os.makedirs(s1_weight_dir, exist_ok=True)
    os.makedirs(f"{exp_dir}/logs_s1", exist_ok=True)
    s1["train"].update(
        {
            "precision": "32",
            "batch_size": args.batch,
            "epochs": args.gpt_epochs,
            "save_every_n_epoch": args.gpt_epochs,
            "if_save_every_weights": True,
            "if_save_latest": True,
            "if_dpo": False,
            "half_weights_save_dir": s1_weight_dir,
            "exp_name": args.name,
        }
    )
    s1["pretrained_s1"] = PRETRAINED_S1
    s1["train_semantic_path"] = f"{exp_dir}/6-name2semantic.tsv"
    s1["train_phoneme_path"] = f"{exp_dir}/2-name2text.txt"
    s1["output_dir"] = f"{exp_dir}/logs_s1_{args.version}"
    s1_tmp = "TEMP/fv_s1.yaml"
    with open(s1_tmp, "w", encoding="utf8") as f:
        yaml.dump(s1, f, default_flow_style=False)
    run("GPT_SoVITS/s1_train.py", {**common, "hz": "25hz"}, ["--config_file", s1_tmp])

    # 取最新的一份權重複製出去
    sovits = max(glob.glob(f"{s2_weight_dir}/{args.name}_e*.pth"), key=os.path.getmtime)
    gpt = max(glob.glob(f"{s1_weight_dir}/{args.name}-e*.ckpt"), key=os.path.getmtime)
    os.makedirs(out_dir, exist_ok=True)
    shutil.copy2(sovits, os.path.join(out_dir, "sovits.pth"))
    shutil.copy2(gpt, os.path.join(out_dir, "gpt.ckpt"))
    meta = {
        "engine": "GPT-SoVITS",
        "version": args.version,
        "sovits_epochs": args.sovits_epochs,
        "gpt_epochs": args.gpt_epochs,
        "batch": args.batch,
        "source_sovits": sovits,
        "source_gpt": gpt,
        "trained_at": time.strftime("%Y-%m-%d %H:%M"),
    }
    with open(os.path.join(out_dir, "model.json"), "w", encoding="utf8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"[fv] 模型已輸出到 {out_dir}")


if __name__ == "__main__":
    main()
