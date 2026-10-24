// 讀旁白時間表（fv timeline 寫的 build/narration.json），查「某一句念到某個詞」的時間。
// 錄影腳本用它排每一個點擊，合成用它排字卡與標註，兩邊對的是同一份時間。
//
//   import { loadNarration } from '<工具>/lib/narration.mjs';
//   const N = loadNarration(projectDir);
//   N.at('L09')                 // L09 開始念的秒數（全片時間）
//   N.at('L09', '求助')          // 念到「求助」第一個字的秒數
//   N.at('L09', '求助', { edge: 'end' })   // 「求助」念完的秒數
//   N.end('L09')                // L09 念完
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadNarration(projectDir) {
  const nar = JSON.parse(readFileSync(join(projectDir, 'build', 'narration.json'), 'utf8'));
  const byId = Object.fromEntries(nar.lines.map((l) => [l.id, l]));
  const line = (id) => {
    const l = byId[id];
    if (!l) throw new Error(`narration.json 沒有 ${id}`);
    return l;
  };
  return {
    ...nar,
    line,
    end: (id) => line(id).end,
    /** phrase 不給就是句首；nth 第幾次出現（從 0 算）；edge 'start' | 'end' */
    at(id, phrase, { edge = 'start', nth = 0 } = {}) {
      const l = line(id);
      if (!phrase) return edge === 'end' ? l.end : l.start;
      if (!l.chars) throw new Error(`${id} 沒有逐字時間，先跑 fv timeline（要能跑 whisper）`);
      const text = l.chars.map((c) => c.c).join('');
      let i = -1;
      for (let k = 0; k <= nth; k++) {
        i = text.indexOf(phrase, i + 1);
        if (i < 0) throw new Error(`${id}「${l.text}」裡沒有第 ${nth + 1} 個「${phrase}」`);
      }
      return edge === 'end' ? l.chars[i + phrase.length - 1].e : l.chars[i].s;
    },
  };
}
