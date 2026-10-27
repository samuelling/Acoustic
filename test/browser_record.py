# Plays a short progression in headless Chromium through the real page and saves what the Record button captures.
import base64, sys
from playwright.sync_api import sync_playwright
out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0/out/browser_take.wav'
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page()
    logs = []; pg.on('pageerror', lambda e: logs.append(str(e)))
    pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(500)
    pg.click('#startBtn'); pg.wait_for_timeout(500)
    pg.click('#recBtn'); pg.wait_for_timeout(200)
    pg.evaluate("""async () => {
      const A = window.__acoustic, S = A.strum, w = (ms) => new Promise(r => setTimeout(r, ms));
      const chord = async (notes, vel, hold) => { notes.forEach(n => S.noteOn(n, vel)); await w(hold); notes.forEach(n => S.noteOff(n)); };
      const C = [48, 52, 55, 60], G = [43, 47, 50, 55, 59, 67], Am = [45, 52, 57, 60, 64], F = [41, 48, 53, 57, 60, 65];
      // 8th-note strumming at ~100 bpm: D D U U D U  (pendulum should infer directions)
      const e = 300;
      for (const ch of [C, G, Am, F]) {
        await chord(ch, 0.85, e*0.9); await w(e*0.1);
        await chord(ch, 0.7, e*0.9); await w(e*0.1 + e);
        await chord(ch, 0.6, e*0.9); await w(e*0.1);
        await chord(ch, 0.8, e*0.9); await w(e*0.1);
        await chord(ch, 0.6, e*0.9); await w(e*0.1);
      }
      S.set({ mode: 'finger' }); await chord(C, 0.7, 1500); S.set({ mode: 'pick' });
      // melody notes
      for (const n of [64, 67, 72, 71, 67, 64]) { await chord([n], 0.7, 250); }
      await w(1500);
    }""")
    pg.click('#recBtn'); pg.wait_for_timeout(300)
    data = pg.evaluate("""async () => { const r = await fetch(document.querySelector('#recOut audio').src); const buf = new Uint8Array(await r.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); }""")
    open(out, 'wb').write(base64.b64decode(data))
    print('saved', out, 'errors:', logs)
    b.close()
