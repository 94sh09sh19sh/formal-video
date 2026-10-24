#!/usr/bin/env node
// formal-video 指令列。每個子指令的說明：node fv.mjs help
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `formal-video（fv）

  doctor                         檢查 ffmpeg、Node、HyperFrames、語音引擎、Chrome
  init <專案目錄>                 建影片專案骨架（brief、sources、script、video.json）
  lint <專案目錄>                 旁白：長度估算、禁用詞、支語、數字有沒有掛引用
  voice prep|train|say|asr|sim    語音：切句對稿／微調／逐句合成／辨識／聲紋相似度（參數見 references/voice.md）
  narrate <專案目錄> [--only L03,L05] [--seed N] [--zero-shot]
                                 照 script.md 逐句合成旁白到 audio/narration/（聲音設定在 video.json 的 voice.dir）
  timeline <專案目錄>             每句的起點與逐字時間（whisper 對稿）、字幕分段，寫 build/narration.json 與 .srt
  mix <專案目錄>                  旁白＋音樂（音樂自動壓在旁白下）→ build/mix.wav
  qa <影片> [--script 專案目錄]    長度、響度、黑畫面、凍結、字幕、反聽字錯率、縮圖總表
  master <影片> <輸出前綴>         響度標準化到 -16 LUFS，輸出 1080p 與 720p 兩個版本
`;

// ---------------------------------------------------------------- 設定與外部程式

function config() {
  const base = { engines: join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'formal-video') };
  for (const f of [join(TOOL, 'config.json'), join(TOOL, 'config.local.json')]) {
    if (existsSync(f)) Object.assign(base, JSON.parse(readFileSync(f, 'utf8')));
  }
  return base;
}

function findFfmpeg(cfg) {
  if (cfg.ffmpeg) return cfg.ffmpeg;
  const dir = join(cfg.engines, 'ffmpeg');
  if (existsSync(dir)) {
    for (const d of readdirSync(dir)) {
      const exe = join(dir, d, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      if (existsSync(exe)) return exe;
    }
  }
  return 'ffmpeg';
}

const CFG = config();
const FFMPEG = findFfmpeg(CFG);
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, (m, ext) => `ffprobe${ext ?? ''}`);
const PY = join(CFG.engines, 'engines', 'gsv-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const GSV = join(CFG.engines, 'engines', 'GPT-SoVITS');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (opts.check !== false && r.status !== 0) {
    throw new Error(`${basename(cmd)} 失敗（${r.status}）：${(r.stderr || r.stdout || '').slice(-2000)}`);
  }
  return r;
}

const pyEnv = () => ({ ...process.env, PYTHONIOENCODING: 'utf-8', HF_HOME: join(CFG.engines, 'hf-cache'), PATH: `${dirname(FFMPEG)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` });

// ---------------------------------------------------------------- 專案檔讀取

/** 讀 script.md 的「旁白」表：編號以 L 開頭的列 */
export function readNarration(projectDir) {
  const text = readFileSync(join(projectDir, 'script.md'), 'utf8');
  const lines = [];
  let header = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = raw.slice(1, raw.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.every((c) => /^-*$/.test(c))) continue;
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    if (/^L\d+/.test(row['編號'] ?? '')) {
      lines.push({
        id: row['編號'],
        section: row['段落'],
        // 旁白裡的「｜」是字幕的換段處，念的時候拿掉
        text: row['旁白'],
        say: (row['念法'] || row['旁白']).replaceAll('｜', ''),
        cites: (row['引用'] || '').split(/[\s,，、]+/).filter(Boolean),
        pause: Number(row['停頓'] || 0.5),
      });
    }
  }
  return lines;
}

function readVideoJson(projectDir) {
  const f = join(projectDir, 'video.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

function readSourceIds(projectDir) {
  const f = join(projectDir, 'sources.md');
  if (!existsSync(f)) return new Set();
  return new Set([...readFileSync(f, 'utf8').matchAll(/^\|\s*(S\d+)\s*\|/gm)].map((m) => m[1]));
}

/** 支語詞庫：zhiyu-check 的全域詞庫＋往上找到的專案特例（!放行、-停用） */
function zhiyuPairs(projectDir) {
  const pairs = new Map();
  const allowed = [];
  const files = [join(homedir(), '.claude', 'zhiyu-check', 'zhiyu-words.txt'), join(homedir(), '.claude', 'zhiyu-check', 'zhiyu-words.local.txt')];
  for (let d = resolve(projectDir); ; d = dirname(d)) {
    const f = join(d, '.claude', 'zhiyu-allow.txt');
    if (existsSync(f)) files.push(f);
    if (dirname(d) === d) break;
  }
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      if (l.startsWith('!')) allowed.push(l.slice(1).trim());
      else if (l.startsWith('-')) pairs.delete(l.slice(1).trim());
      else {
        const [w, g] = l.split('\t').map((s) => s.trim());
        if (w) pairs.set(w, g || '');
      }
    }
  }
  return { pairs, allowed };
}

/** 中文旁白每秒字數（含標點的停頓已另計），英文字母以 0.5 字計 */
const CHARS_PER_SEC = 4.2;
export function speechSeconds(text) {
  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  const commas = (text.match(/[，、；：,;:]/g) ?? []).length;
  return han / CHARS_PER_SEC + latin * 0.12 + commas * 0.25;
}

// ---------------------------------------------------------------- 子指令

function doctor() {
  const rows = [];
  const check = (name, ok, detail) => rows.push(`${ok ? '✔' : '✘'} ${name}${detail ? `：${detail}` : ''}`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('Node.js ≥ 22', nodeMajor >= 22, process.versions.node);
  const ff = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' });
  check('ffmpeg', ff.status === 0, ff.status === 0 ? ff.stdout.split('\n')[0] : `找不到（${FFMPEG}）`);
  const py = existsSync(PY) ? spawnSync(PY, ['-c', 'import torch,faster_whisper;print(torch.__version__)'], { encoding: 'utf8' }) : null;
  check('語音環境（PyTorch、faster-whisper）', py?.status === 0, py?.status === 0 ? py.stdout.trim() : `沒有 ${PY}`);
  check('GPT-SoVITS 引擎與底模', existsSync(join(GSV, 'GPT_SoVITS', 'pretrained_models', 'v2Pro')), GSV);
  check('G2PW（中文多音字）', existsSync(join(GSV, 'GPT_SoVITS', 'text', 'G2PWModel')));
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(existsSync);
  check('Chrome（Playwright 用 channel: chrome）', Boolean(chrome), chrome);
  check(`HyperFrames（npx hyperframes@${CFG.hyperframes ?? '0.8.143'}）`, true, '第一次執行時 npx 會下載');
  console.log(rows.join('\n'));
}

function init(dir) {
  if (!dir) throw new Error('要給專案目錄');
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} 不是空的`);
  cpSync(join(TOOL, 'templates', 'project'), target, { recursive: true });
  console.log(`已建立 ${target}；先填 brief.md 與 video.json，再照 SKILL.md 的階段走`);
}

function lint(dir) {
  const projectDir = resolve(dir);
  const lines = readNarration(projectDir);
  const video = readVideoJson(projectDir);
  const sources = readSourceIds(projectDir);
  const { pairs, allowed } = zhiyuPairs(projectDir);
  const banned = video.bannedTerms ?? [];
  const problems = [];
  let total = 0;
  for (const l of lines) {
    const secs = speechSeconds(l.say) + l.pause;
    total += secs;
    for (const w of banned) if (l.text.includes(w) || l.say.includes(w)) problems.push(`${l.id} 禁用詞「${w}」`);
    let masked = l.text.replaceAll('｜', '');
    for (const a of allowed) masked = masked.split(a).join('');
    for (const [w, g] of pairs) if (masked.includes(w)) problems.push(`${l.id} 支語「${w}」→ ${g || '改寫'}`);
    // 統計數字才要出處：阿拉伯數字、百分比、兩個字以上的國字數量（「每一床」「一眼」這種單一的「一」不算）
    const numeric = /[0-9０-９%％]|百分之|[零一二兩三四五六七八九十百千萬]{2,}(?:人|次|小時|成|倍|床|年|分鐘)|[兩二三四五六七八九][成倍]/.test(l.text);
    if (numeric && l.cites.length === 0 && !(video.numbersWithoutCitation ?? []).includes(l.id)) problems.push(`${l.id} 有數字但沒有引用`);
    for (const c of l.cites) if (!sources.has(c)) problems.push(`${l.id} 引用 ${c} 不在 sources.md`);
    const perLine = video.maxCharsPerLine ?? 32;
    if (l.text.replaceAll('｜', '').length > perLine) problems.push(`${l.id} 一句 ${l.text.length} 字，超過 ${perLine}`);
    const clauses = l.text.split(/[｜，。、；：！？]/).filter((c) => c.length > (video.captionMaxChars ?? 16));
    if (clauses.length) problems.push(`${l.id} 字幕會在詞中間斷開（「${clauses[0]}」超過 ${video.captionMaxChars ?? 16} 字）；在稿裡用「｜」標斷點`);
    // 旁白也是字幕：分號、冒號在字幕裡很怪（念起來也是一個長停頓），改成句號拆兩句或改寫；中文裡不用半形標點
    if (/；/.test(l.text)) problems.push(`${l.id} 有分號：改成句號拆成兩句，或改寫成逗號`);
    if (/：/.test(l.text)) problems.push(`${l.id} 有冒號：改寫（例：「顯示：護理師收到了」→「顯示「護理師收到了」」）`);
    if (/[㐀-鿿][,.;:!?]|[,.;:!?][㐀-鿿]/.test(l.text)) problems.push(`${l.id} 中文旁混了半形標點，改全形`);
    if (!/[。！？]$/.test(l.text)) problems.push(`${l.id} 句尾沒有句號、問號或驚嘆號`);
  }
  const [lo, hi] = video.narrationSeconds ?? [0, Infinity];
  console.log(`旁白 ${lines.length} 句，估計 ${total.toFixed(1)} 秒（每秒 ${CHARS_PER_SEC} 字＋停頓）${total < lo || total > hi ? `，不在目標 ${lo}–${hi} 秒內` : ''}`);
  if (problems.length) {
    console.log(problems.map((p) => `✘ ${p}`).join('\n'));
    process.exitCode = 1;
  } else console.log('✔ 沒有問題');
}

function voice(args) {
  const [sub, ...rest] = args;
  const script = { prep: 'voice_prep.py', train: 'gsv_train.py', say: 'gsv_say.py', asr: 'asr.py', sim: 'voice_sim.py' }[sub];
  if (!script) throw new Error('voice 後面接 prep、train、say、asr 或 sim');
  const extra = sub === 'train' && !rest.includes('--engine') ? ['--engine', GSV] : [];
  const lead = sub === 'sim' ? [GSV] : [];
  const extraPrep = sub === 'prep' && !rest.includes('--ffmpeg') ? ['--ffmpeg', FFMPEG] : [];
  const r = spawnSync(PY, [join(TOOL, 'py', script), ...lead, ...rest, ...extra, ...extraPrep], { stdio: 'inherit', env: pyEnv() });
  process.exitCode = r.status ?? 1;
}

/**
 * 旁白合成：聲音目錄（video.json 的 voice.dir）要有 voice.json：
 *   { "refAudio": "相對聲音目錄的參考音", "refText": "參考音逐字稿", "sovits": "model/sovits.pth", "gpt": "model/gpt.ckpt", "version": "v2ProPlus" }
 * --zero-shot 不用微調過的模型（比較用）。
 */
function narrate(dir, args) {
  const projectDir = resolve(dir);
  const video = readVideoJson(projectDir);
  const voiceDir = resolve(projectDir, video.voice?.dir ?? '');
  const profile = JSON.parse(readFileSync(join(voiceDir, 'voice.json'), 'utf8'));
  const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
  const zero = args.includes('--zero-shot');
  const seedBase = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : undefined;
  const lines = readNarration(projectDir).filter((l) => !only || only.has(l.id));
  const outDir = join(projectDir, 'audio', zero ? 'narration-zeroshot' : 'narration');
  mkdirSync(outDir, { recursive: true });
  const job = {
    engine: GSV,
    version: profile.version ?? 'v2ProPlus',
    sovits: zero ? null : join(voiceDir, profile.sovits),
    gpt: zero ? null : join(voiceDir, profile.gpt),
    ref_audio: join(voiceDir, profile.refAudio),
    ref_text: profile.refText,
    out_dir: outDir,
    asr_model: 'large-v3',
    max_cer: video.voice?.maxCer ?? 0.05,
    tries: video.voice?.tries ?? 4,
    speed: video.voice?.speed ?? 1.0,
    lines: lines.map((l) => ({ id: l.id, text: l.say, expect: l.say })),
    ...(seedBase ? { seed_base: seedBase } : {}),
  };
  const jobFile = join(outDir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(job, null, 1));
  const r = spawnSync(PY, [join(TOOL, 'py', 'gsv_say.py'), jobFile], { stdio: 'inherit', env: pyEnv() });
  process.exitCode = r.status ?? 1;
}

function probeSeconds(file) {
  return Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.trim());
}

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

const PUNCT = /[，。、；：！？「」『』（）…—,.;:!?()\s　]/;

/**
 * 字幕標點（台灣字幕慣例）：句中的逗號、句號、分號、冒號換成全形空白，句尾不留；問號、驚嘆號、頓號、引號照留。
 * 稿裡不該出現分號、冒號（lint 會擋），這裡仍一併處理，避免漏網。
 */
export function captionText(raw) {
  return raw.replace(/[，。；：,.;:]+/g, '　').replace(/　{2,}/g, '　').replace(/^　+|　+$/g, '');
}

/**
 * 旁白切成字幕段：「｜」一定切；否則一個子句（逗號、句號等結尾）一段，4 字以下的短子句併進相鄰那段。
 * 回傳原文的連續片段（標點還在），接起來等於去掉「｜」的旁白；顯示前再過 captionText。
 * 一段還是超過 max 的平均切開（lint 會先要求在稿裡標「｜」）。
 */
export function splitCaption(text, max = 16) {
  if (text.includes('｜')) return text.split('｜').flatMap((t) => splitCaption(t, max));
  const core = (s) => s.replace(/[，。、；：！？,.;:!?]+$/, '');
  const pieces = [];
  const clauses = text.split(/(?<=[，。；：！？,.;:!?])/).filter((s) => s.trim());
  let carry = '';
  clauses.forEach((raw, i) => {
    const c = carry + raw;
    carry = '';
    // 「所以，」「下一步，」這種帶出下文的短句跟下一段走
    if (core(c).length <= 4 && /[，：,:]$/.test(c) && i + 1 < clauses.length) {
      carry = c;
      return;
    }
    const prev = pieces.at(-1);
    if (prev !== undefined && (core(prev).length <= 4 || core(c).length <= 4) && captionText(prev + c).length <= max) pieces[pieces.length - 1] = prev + c;
    else pieces.push(c);
  });
  return pieces.flatMap((p) => {
    if (captionText(p).length <= max) return [p];
    const n = Math.ceil(core(p).length / max);
    const size = Math.ceil(p.length / n);
    return Array.from({ length: n }, (_, i) => p.slice(i * size, (i + 1) * size));
  });
}

/**
 * 稿子每個字對到音檔裡的時間：whisper 的詞（詞內平均分給每個字）與稿子做最長共同子序列，
 * 對得上的字用辨識的時間；對不上的（同音別字、數字寫法不同、沒念到）在前後對得上的字之間平均內插；標點不佔時間。
 * 回傳 { chars: [{ c, s, e }]（秒，相對於這一句開頭，長度等於 plain）, matched, total }。
 */
export function alignChars(plain, words, secs) {
  const heard = [];
  for (const w of words) {
    const cs = [...w.w].filter((c) => !PUNCT.test(c));
    cs.forEach((c, k) => heard.push({ c, s: w.s + ((w.e - w.s) * k) / cs.length, e: w.s + ((w.e - w.s) * (k + 1)) / cs.length }));
  }
  const chars = [...plain];
  const idx = chars.map((c, i) => (PUNCT.test(c) ? -1 : i)).filter((i) => i >= 0);
  const A = idx.map((i) => chars[i].toUpperCase());
  const B = heard.map((h) => h.c.toUpperCase());
  const dp = Array.from({ length: A.length + 1 }, () => new Int16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const match = new Array(A.length).fill(-1);
  for (let i = 0, j = 0; i < A.length && j < B.length;) {
    if (A[i] === B[j]) match[i++] = j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const times = new Array(A.length);
  for (let i = 0; i < A.length;) {
    if (match[i] >= 0) {
      times[i] = { s: heard[match[i]].s, e: heard[match[i]].e };
      i++;
      continue;
    }
    let k = i;
    while (k < A.length && match[k] < 0) k++;
    const from = i === 0 ? Math.min(heard[0]?.s ?? 0, k < A.length ? heard[match[k]].s : secs) : times[i - 1].e;
    const to = k < A.length ? heard[match[k]].s : Math.max(from, heard.at(-1)?.e ?? secs);
    const step = (Math.max(to, from) - from) / (k - i);
    for (let m = i; m < k; m++) times[m] = { s: from + step * (m - i), e: from + step * (m - i + 1) };
    i = k;
  }
  const out = [];
  let last = 0;
  let a = 0;
  for (let i = 0; i < chars.length; i++) {
    if (idx[a] === i) {
      out.push({ c: chars[i], s: times[a].s, e: times[a].e });
      last = times[a].e;
      a++;
    } else out.push({ c: chars[i], s: last, e: last });
  }
  return { chars: out, matched: match.filter((m) => m >= 0).length, total: A.length };
}

/** 沒有 whisper 時的退路：照字數平均分（標點約停一個字的 1 倍） */
function evenChars(plain, secs) {
  const chars = [...plain];
  const total = chars.length;
  return chars.map((c, i) => {
    const s = (secs * i) / total;
    return PUNCT.test(c) ? { c, s, e: s } : { c, s, e: (secs * (i + 1)) / total };
  });
}

/** 每一句的逐字辨識（py/words.py），結果快取在 audio/narration/<編號>.words.json */
function wordTimes(projectDir, lines) {
  const items = lines.map((l) => ({ wav: join(projectDir, 'audio', 'narration', `${l.id}.wav`), out: join(projectDir, 'audio', 'narration', `${l.id}.words.json`) }));
  if (!existsSync(PY)) {
    console.log('⚠ 找不到語音引擎的 Python，字幕與逐字時間改用字數平均分配');
    return null;
  }
  const jobFile = join(projectDir, 'audio', 'narration', 'words-job.json');
  writeFileSync(jobFile, JSON.stringify({ model: 'large-v3', items }, null, 1));
  const r = spawnSync(PY, [join(TOOL, 'py', 'words.py'), jobFile], { stdio: 'inherit', env: pyEnv() });
  if (r.status !== 0) {
    console.log('⚠ 逐字辨識失敗，字幕與逐字時間改用字數平均分配');
    return null;
  }
  return Object.fromEntries(lines.map((l, i) => [l.id, JSON.parse(readFileSync(items[i].out, 'utf8')).words]));
}

/**
 * 旁白時間表。音檔在 audio/narration/<編號>.wav；起點：video.json 的 cues 指定的優先（{ "L08": 41.2 }），
 * 其餘接在上一句後面加停頓。每一句帶逐字時間（chars，全片秒數），lib/narration.mjs 用它查「念到某個詞」；
 * 字幕每段從它第一個字念出來開始，到下一段開始（最後一段到句尾後 0.25 秒）。
 */
function timeline(dir) {
  const projectDir = resolve(dir);
  const lines = readNarration(projectDir);
  const video = readVideoJson(projectDir);
  const cues = video.cues ?? {};
  for (const l of lines) if (!existsSync(join(projectDir, 'audio', 'narration', `${l.id}.wav`))) throw new Error(`沒有 ${l.id}.wav，先跑 fv narrate`);
  const words = wordTimes(projectDir, lines);
  let t = video.narrationStart ?? 0.6;
  const out = [];
  const srt = [];
  const weak = [];
  for (const l of lines) {
    const file = join(projectDir, 'audio', 'narration', `${l.id}.wav`);
    const secs = probeSeconds(file);
    if (cues[l.id] !== undefined) {
      if (cues[l.id] < t - 0.05) console.log(`⚠ ${l.id} 指定在 ${cues[l.id]} 秒，但上一句到 ${t.toFixed(2)} 秒才講完`);
      t = cues[l.id];
    }
    const plain = l.text.replaceAll('｜', '');
    let rel;
    if (words) {
      const a = alignChars(plain, words[l.id], secs);
      rel = a.chars;
      if (a.matched < a.total * 0.7) weak.push(`${l.id}（${a.matched}/${a.total} 字對得上）`);
    } else rel = evenChars(plain, secs);
    const chars = rel.map((c) => ({ c: c.c, s: Number((t + c.s).toFixed(3)), e: Number((t + c.e).toFixed(3)) }));
    out.push({ id: l.id, section: l.section, text: l.text, file, start: Number(t.toFixed(3)), end: Number((t + secs).toFixed(3)), chars });
    const parts = splitCaption(l.text, video.captionMaxChars ?? 16);
    let off = 0;
    const starts = parts.map((p) => {
      const first = [...p].findIndex((c) => !PUNCT.test(c));
      const s = chars[off + Math.max(0, first)].s;
      off += [...p].length;
      return s;
    });
    parts.forEach((p, i) => {
      const s = i === 0 ? Math.min(starts[0], t + 0.05) : starts[i];
      const e = i + 1 < parts.length ? starts[i + 1] : t + secs + 0.25;
      srt.push({ start: Number(s.toFixed(3)), end: Number(e.toFixed(3)), text: captionText(p) });
    });
    t += secs + l.pause;
  }
  if (weak.length) console.log(`⚠ 這幾句辨識和稿子差很多，逐字時間多半是內插的，念到的詞請自己聽一下：${weak.join('、')}`);
  mkdirSync(join(projectDir, 'build'), { recursive: true });
  writeFileSync(join(projectDir, 'build', 'narration.json'), JSON.stringify({ lines: out, captions: srt, end: t }, null, 1));
  writeFileSync(join(projectDir, 'build', 'captions.srt'), srt.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n'));
  console.log(`旁白 ${out.length} 句，最後一句在 ${out.at(-1).end.toFixed(1)} 秒講完；寫出 build/narration.json、build/captions.srt`);
}

/**
 * 旁白＋音樂：旁白各句照 narration.json 擺好；音樂（video.json 的 music.file）用 sidechain 壓在旁白下，
 * 頭尾淡入淡出；輸出 48 kHz 雙聲道 build/mix.wav 與只有旁白的 build/voice.wav。
 */
function mix(dir) {
  const projectDir = resolve(dir);
  const video = readVideoJson(projectDir);
  const nar = JSON.parse(readFileSync(join(projectDir, 'build', 'narration.json'), 'utf8'));
  const total = video.duration ?? Math.ceil(nar.end + 2);
  const inputs = [];
  const filters = [];
  nar.lines.forEach((l, i) => {
    inputs.push('-i', l.file);
    const ms = Math.round(l.start * 1000);
    filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[v${i}]`);
  });
  const n = nar.lines.length;
  filters.push(`${nar.lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${n}:normalize=0,apad,atrim=0:${total},asplit=3[voice][key][vout]`);
  const music = video.music?.file ? resolve(projectDir, video.music.file) : null;
  let last = '[voice]';
  if (music) {
    const mGain = video.music.gainDb ?? -20;
    // align: "start"（預設，從頭開始、不夠長就重複播）或 "end"（只播一次，讓曲子自然的結尾落在片尾，開頭延後進來）
    const alignEnd = video.music.align === 'end';
    const musicLen = probeSeconds(music);
    if (alignEnd) inputs.push('-i', music);
    else inputs.push('-stream_loop', '-1', '-i', music);
    const delayMs = alignEnd ? Math.max(0, Math.round((total - musicLen - (video.music.tail ?? 0.5)) * 1000)) : 0;
    const fade = alignEnd
      ? `afade=t=in:d=${video.music.fadeIn ?? 1.5}`
      : `afade=t=in:d=${video.music.fadeIn ?? 1.5},afade=t=out:st=${Math.max(0, total - (video.music.fadeOut ?? 3))}:d=${video.music.fadeOut ?? 3}`;
    filters.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${mGain}dB,${fade},adelay=${delayMs}:all=1,apad,atrim=0:${total}[m]`);
    filters.push(`[key]aformat=channel_layouts=stereo[k2]`);
    // 旁白出現時音樂再壓低約 8 dB，放開要 0.6 秒，聽起來不會一跳一跳
    filters.push(`[m][k2]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=600:makeup=1[mduck]`);
    filters.push(`[voice]aformat=channel_layouts=stereo[vs]`);
    filters.push(`[vs][mduck]amix=inputs=2:normalize=0[mixed]`);
    last = '[mixed]';
  } else {
    filters.push(`[voice]aformat=channel_layouts=stereo[mixed]`);
    filters.push('[key]anullsink');
    last = '[mixed]';
  }
  const out = join(projectDir, 'build', 'mix.wav');
  const outputs = ['-map', last, '-ar', '48000', '-c:a', 'pcm_s24le', out,
    '-map', '[vout]', '-ar', '48000', '-c:a', 'pcm_s24le', join(projectDir, 'build', 'voice.wav')];
  // 無旁白版用的純音樂另外輸出（不壓低，比有旁白時大 6 dB）
  run(FFMPEG, ['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), ...outputs]);
  if (music) {
    const m = video.music;
    const alignEnd = m.align === 'end';
    const delayMs = alignEnd ? Math.max(0, Math.round((total - probeSeconds(music) - (m.tail ?? 0.5)) * 1000)) : 0;
    run(FFMPEG, ['-v', 'error', '-y', ...(alignEnd ? [] : ['-stream_loop', '-1']), '-i', music, '-af',
      `aresample=48000,aformat=channel_layouts=stereo,volume=${(m.gainDb ?? -20) + 6}dB,afade=t=in:d=${m.fadeIn ?? 1.5},adelay=${delayMs}:all=1,apad,atrim=0:${total}`,
      '-c:a', 'pcm_s24le', join(projectDir, 'build', 'music.wav')]);
  }
  console.log(`寫出 ${out}（${total} 秒${music ? '，含音樂；另有無旁白版用的 build/music.wav' : ''}）`);
}

function loudness(file) {
  const r = run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { check: false });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  return { I: Number(summary.match(/I:\s+(-?[\d.]+)/)?.[1]), TP: Number(summary.match(/Peak:\s+(-?[\d.]+)/)?.[1]) };
}

function qa(file, args) {
  const video = resolve(file);
  const projectDir = args.includes('--script') ? resolve(args[args.indexOf('--script') + 1]) : null;
  const cfg = projectDir ? readVideoJson(projectDir) : {};
  const report = [];
  const add = (ok, msg) => report.push(`${ok ? '✔' : '✘'} ${msg}`);
  const secs = probeSeconds(video);
  const [lo, hi] = cfg.durationRange ?? [0, Infinity];
  add(secs >= lo && secs <= hi, `長度 ${secs.toFixed(1)} 秒（目標 ${lo}–${hi}）`);
  const { I, TP } = loudness(video);
  const target = cfg.loudness ?? -16;
  add(Math.abs(I - target) <= 1, `整體響度 ${I} LUFS（目標 ${target} ±1）`);
  add(TP <= (cfg.truePeak ?? -1.5), `峰值 ${TP} dBFS（上限 ${cfg.truePeak ?? -1.5}）`);
  const black = run(FFMPEG, ['-hide_banner', '-nostats', '-i', video, '-vf', 'blackdetect=d=0.5:pix_th=0.08', '-an', '-f', 'null', '-'], { check: false }).stderr.match(/black_start:[\d.]+ black_end:[\d.]+/g) ?? [];
  add(black.length === 0, `黑畫面 ${black.length} 段${black.length ? `：${black.join('；')}` : ''}`);
  const freezeLimit = cfg.maxFreezeSeconds ?? 6;
  const freezes = run(FFMPEG, ['-hide_banner', '-nostats', '-i', video, '-vf', `freezedetect=n=0.001:d=${freezeLimit}`, '-an', '-f', 'null', '-'], { check: false }).stderr.match(/freeze_start: [\d.]+/g) ?? [];
  add(freezes.length === 0, `超過 ${freezeLimit} 秒完全不動的畫面 ${freezes.length} 段${freezes.length ? `：${freezes.join('；')}` : ''}`);
  if (projectDir && existsSync(join(projectDir, 'build', 'captions.srt'))) {
    const blocks = readFileSync(join(projectDir, 'build', 'captions.srt'), 'utf8').trim().split(/\r?\n\r?\n/);
    const toS = (t) => { const [h, m, s] = t.replace(',', '.').split(':').map(Number); return h * 3600 + m * 60 + s; };
    let worst = 0;
    let longest = 0;
    let shortest = Infinity;
    const badPunct = [];
    for (const b of blocks) {
      const [, time, ...txt] = b.split(/\r?\n/);
      const [a, z] = time.split(' --> ').map(toS);
      const t = txt.join('');
      longest = Math.max(longest, ...txt.map((x) => x.length));
      worst = Math.max(worst, t.length / Math.max(0.1, z - a));
      shortest = Math.min(shortest, z - a);
      if (/[，。；：,.;:]/.test(t)) badPunct.push(t);
    }
    add(longest <= (cfg.captionMaxChars ?? 16), `字幕最長一行 ${longest} 字`);
    add(worst <= (cfg.captionMaxCps ?? 7), `字幕最快每秒 ${worst.toFixed(1)} 字（上限 ${cfg.captionMaxCps ?? 7}）`);
    add(shortest >= 0.8, `字幕最短停留 ${shortest.toFixed(2)} 秒（下限 0.8）`);
    add(badPunct.length === 0, `字幕裡的逗號、句號、分號、冒號 ${badPunct.length} 段${badPunct.length ? `：${badPunct.slice(0, 3).join('／')}` : ''}（台灣字幕慣例以全形空白代替）`);
  }
  // 縮圖總表：每 2 秒一格，給人審片
  const sheet = video.replace(/\.[^.]+$/, '.contact.jpg');
  const cols = 6;
  const rowsN = Math.ceil(secs / 2 / cols);
  run(FFMPEG, ['-v', 'error', '-y', '-i', video, '-vf', `fps=1/2,scale=320:-1,drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6,tile=${cols}x${rowsN}`, '-frames:v', '1', sheet], { check: false });
  add(existsSync(sheet), `縮圖總表 ${sheet}`);
  console.log(report.join('\n'));
  if (report.some((r) => r.startsWith('✘'))) process.exitCode = 1;
}

/** 兩段式 loudnorm 到 -16 LUFS；true peak 目標 -2（AAC 編碼後會再高約 0.5 dB，qa 的上限是 -1.5）；影像直接複製，再另出 720p */
function master(file, prefix) {
  const src = resolve(file);
  const out = resolve(prefix);
  const probe = run(FFMPEG, ['-hide_banner', '-nostats', '-i', src, '-af', 'loudnorm=I=-16:TP=-2:LRA=11:print_format=json', '-f', 'null', '-'], { check: false }).stderr;
  const m = JSON.parse(probe.slice(probe.lastIndexOf('{'), probe.lastIndexOf('}') + 1));
  const ln = `loudnorm=I=-16:TP=-2:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  run(FFMPEG, ['-v', 'error', '-y', '-i', src, '-c:v', 'copy', '-af', `${ln},aresample=48000`, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', `${out}_1080p.mp4`]);
  run(FFMPEG, ['-v', 'error', '-y', '-i', `${out}_1080p.mp4`, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-c:a', 'copy', '-movflags', '+faststart', `${out}_720p.mp4`]);
  for (const f of [`${out}_1080p.mp4`, `${out}_720p.mp4`]) console.log(`${f}（${(statSync(f).size / 1e6).toFixed(1)} MB）`);
}

// ---------------------------------------------------------------- 進入點

// 被 import 時（拿 readNarration 等函式）不執行指令列
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const [cmd, ...args] = isMain ? process.argv.slice(2) : ['__lib__'];
if (isMain) try {
  switch (cmd) {
    case 'doctor': doctor(); break;
    case 'init': init(args[0]); break;
    case 'lint': lint(args[0] ?? '.'); break;
    case 'voice': voice(args); break;
    case 'narrate': narrate(args[0] ?? '.', args.slice(1)); break;
    case 'timeline': timeline(args[0] ?? '.'); break;
    case 'mix': mix(args[0] ?? '.'); break;
    case 'qa': qa(args[0], args.slice(1)); break;
    case 'master': master(args[0], args[1]); break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error(`fv ${cmd}：${e.message}`);
  process.exitCode = 1;
}
