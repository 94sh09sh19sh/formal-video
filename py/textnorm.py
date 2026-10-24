"""比對旁白與辨識結果用的正規化與錯誤率。

兩邊都：繁轉簡（只為比對，不輸出）＋少數兩岸寫法不同的詞對齊 → 阿拉伯數字轉中文數字 → 去標點與空白 → 英文轉小寫。
- cer：字錯率。辨識常把同音字寫錯（紀錄／記錄、一／亦），會誤判。
- per：拼音錯率（不分聲調），同音字不算錯、真的念錯（說→守、床→場）仍算；判斷合成語音念得對不對用這個。
"""
import re
import unicodedata

from opencc import OpenCC

_t2s = OpenCC("t2s")
_PUNCT = re.compile(r"[\s\W_]+", re.UNICODE)


def _digits_to_cn(text: str) -> str:
    try:
        import cn2an

        return cn2an.transform(text, "an2cn")
    except Exception:  # cn2an 認不得的寫法就原樣比
        return text


# 辨識常吐大陸寫法的詞（轉成簡體之後的字，用跳脫碼寫；不用 tw2sp，它會把「資料」也替換為大陸用語，反而對不上）
# 「網路」→ 大陸的寫法
_REGIONAL = {"\u7f51\u8def": "\u7f51\u7edc"}


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = _t2s.convert(text)
    for tw, cn in _REGIONAL.items():
        text = text.replace(tw, cn)
    text = _digits_to_cn(text)
    return _PUNCT.sub("", text).lower()


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(reference: str, hypothesis: str) -> float:
    ref, hyp = norm(reference), norm(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def _syllables(text: str) -> list[str]:
    from pypinyin import Style, lazy_pinyin

    return lazy_pinyin(norm(text), style=Style.NORMAL, errors=lambda x: list(x))


def per(reference: str, hypothesis: str) -> float:
    ref, hyp = _syllables(reference), _syllables(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)
