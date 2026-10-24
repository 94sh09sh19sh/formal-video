// 操作畫面錄製：用 DevTools 協定逐格擷取（比 Playwright 內建錄影清楚），每格帶時間戳，
// 結束後依實際間隔組成固定幀率的 mp4。
// 兩種擷取法：
//   screenshot（預設）：連續 Page.captureScreenshot，照 deviceScaleFactor 輸出（1280×800 ×1.5 → 1920×1200），約 25 fps
//   screencast：Page.startScreencast，畫面有變才送格、較省 CPU，但無頭模式下只給 CSS 像素大小
//
// 不直接 import Playwright：影片專案自己裝 playwright-core（版本跟著專案走），把 page 傳進來即可。
//
//   import { chromium } from 'playwright-core';
//   import { createRecorder, tapMarks } from '<工具>/lib/capture.mjs';
//   const page = await context.newPage();
//   await tapMarks(page);                      // 點擊處出現圓點（要在 goto 之前）
//   const rec = await createRecorder(page, { outDir: 'captures/shot5-patient' });
//   await rec.start(); ...操作... ; const clip = await rec.stop();  // { mp4, start, end, frames }
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 點擊、觸控處畫一個淡出的圓，觀眾才看得出「按了哪裡」。只加在被錄的瀏覽器裡，不動被錄的程式。 */
export async function tapMarks(page, { color = 'rgba(37, 99, 235, 0.55)', size = 64 } = {}) {
  await page.addInitScript(
    ({ color, size }) => {
      const show = (x, y) => {
        const dot = document.createElement('div');
        dot.setAttribute('data-fv-tap', '');
        Object.assign(dot.style, {
          position: 'fixed', left: `${x - size / 2}px`, top: `${y - size / 2}px`, width: `${size}px`, height: `${size}px`,
          borderRadius: '50%', background: color, border: '3px solid rgba(255,255,255,0.9)', pointerEvents: 'none',
          zIndex: 2147483647, transform: 'scale(0.6)', opacity: '1', transition: 'transform 450ms ease-out, opacity 650ms ease-in 250ms',
        });
        document.documentElement.appendChild(dot);
        requestAnimationFrame(() => { dot.style.transform = 'scale(1.25)'; dot.style.opacity = '0'; });
        setTimeout(() => dot.remove(), 1000);
      };
      window.addEventListener('pointerdown', (e) => show(e.clientX, e.clientY), true);
    },
    { color, size },
  );
}

const sessions = new WeakMap();
// 帶 clip.scale 的擷取做完，Chrome 會把頁面的 deviceScaleFactor 模擬重設回 1；倍率在第一次建錄影器時記下來，之後都用它
const scales = new WeakMap();

/**
 * 建一個錄影器。outDir 每次 start 會清空。
 * 選項：mode（screenshot｜screencast）、fps（輸出幀率，預設 30）、quality（JPEG 品質，預設 92）、ffmpeg（執行檔路徑）。
 */
export async function createRecorder(page, { outDir, mode = 'screenshot', fps = 30, quality = 92, ffmpeg = process.env.FV_FFMPEG || 'ffmpeg' }) {
  const dir = resolve(outDir);
  // 同一頁只開一個 DevTools 連線：第二個連線的擷取會丟掉 deviceScaleFactor（實測錄成 1280×800）
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  if (!scales.has(page)) scales.set(page, await page.evaluate(() => window.devicePixelRatio));
  const cdp = sessions.get(page);
  let frames = [];
  let recording = false;
  let startedAt = 0;
  let loop = null;

  const save = (data, t) => {
    const file = join(dir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t });
  };

  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    // 先回 ack，瀏覽器才會送下一格
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording) return;
    save(data, metadata.timestamp ?? Date.now() / 1000);
  });

  return {
    async start() {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      frames = [];
      recording = true;
      startedAt = Date.now() / 1000;
      if (mode === 'screenshot') {
        // deviceScaleFactor 不一定反映在擷取結果上；用 clip.scale 明確要求以 dpr 倍率算圖。
        // clip 是文件座標，頁面捲動過就要跟著目前可見範圍的左上角（每格問一次 getLayoutMetrics）
        const vp = page.viewportSize();
        const dpr = scales.get(page);
        loop = (async () => {
          while (recording) {
            const t = Date.now() / 1000;
            const m = await cdp.send('Page.getLayoutMetrics').catch(() => null);
            const v = m?.cssVisualViewport ?? { pageX: 0, pageY: 0 };
            const clip = { x: v.pageX, y: v.pageY, width: vp.width, height: vp.height, scale: dpr };
            const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true, clip, captureBeyondViewport: false }).catch(() => ({}));
            if (data && recording) save(data, t);
          }
        })();
        return startedAt;
      }
      const vp = page.viewportSize();
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality, everyNthFrame: 1,
        maxWidth: Math.round(vp.width * dpr), maxHeight: Math.round(vp.height * dpr),
      });
      return startedAt;
    },
    /** 標一個時間點（例如「按下求助」），合成時拿來對齊旁白。 */
    mark(label) {
      const at = Date.now() / 1000 - startedAt;
      (this.marks ??= []).push({ label, at: Math.round(at * 1000) / 1000 });
      return at;
    },
    async stop() {
      const endedAt = Date.now() / 1000;
      if (mode === 'screenshot') {
        recording = false;
        await loop;
      } else {
        await cdp.send('Page.stopScreencast').catch(() => {});
        // 等最後幾格寫完
        await new Promise((r) => setTimeout(r, 300));
        recording = false;
      }
      if (frames.length === 0) throw new Error(`沒有錄到任何畫面：${dir}`);
      // 畫面沒變時 screencast 不送新格；第一格補到開始、最後一格撐到結束
      const lines = ['ffconcat version 1.0'];
      for (let i = 0; i < frames.length; i++) {
        const from = i === 0 ? startedAt : frames[i].t;
        const to = i + 1 < frames.length ? frames[i + 1].t : endedAt;
        lines.push(`file '${frames[i].file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        lines.push(`duration ${Math.max(0.001, to - from).toFixed(4)}`);
      }
      lines.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`);
      const list = join(dir, 'frames.ffconcat');
      writeFileSync(list, lines.join('\n'));
      const mp4 = `${dir}.mp4`;
      const res = spawnSync(
        ffmpeg,
        ['-v', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', list, '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=pc:out_range=tv,format=yuv420p`,
          // JPEG 是全範圍色彩，不轉成一般影片的有限範圍，瀏覽器播放時顏色會跑掉或整片不顯示
          '-color_range', 'tv', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-movflags', '+faststart', mp4],
        { encoding: 'utf8' },
      );
      if (res.status !== 0) throw new Error(`組影片失敗：${res.stderr}`);
      const meta = { mp4, start: startedAt, end: endedAt, seconds: endedAt - startedAt, frames: frames.length, marks: this.marks ?? [] };
      writeFileSync(`${dir}.json`, JSON.stringify(meta, null, 1));
      this.marks = [];
      return meta;
    },
  };
}
