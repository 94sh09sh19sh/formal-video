"""jieba_fast 的替身：介面相同，轉接純 Python 的 jieba（Windows 沒有 C++ 編譯器時用）。"""
from jieba import *  # noqa: F401,F403
from jieba import dt, lcut, cut, add_word, load_userdict, initialize  # noqa: F401
