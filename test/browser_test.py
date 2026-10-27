import sys, json, time
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/index.html'
shot = sys.argv[2] if len(sys.argv) > 2 else '/tmp/claude-0/out/page.png'
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1100, 'height': 1400})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto(url); pg.wait_for_timeout(800)
    pg.click('#startBtn'); pg.wait_for_timeout(800)
    info = pg.evaluate("""async () => {
      const A = window.__acoustic; const out = {};
      out.state = A.ctx && A.ctx.state; out.sr = A.ctx && A.ctx.sampleRate;
      document.querySelectorAll('.chord')[1].dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
      await new Promise(r => setTimeout(r, 400));
      out.metersAfterChord = A.meters.map(m => +m.e.toFixed(4));
      // keyboard chord via strum engine
      [48, 52, 55, 60].forEach(n => A.strum.noteOn(n, 0.8));
      await new Promise(r => setTimeout(r, 300));
      out.metersAfterKeys = A.meters.map(m => +m.e.toFixed(4));
      out.shape = document.getElementById('shapeText').textContent;
      return out; }""")
    pg.wait_for_timeout(300)
    pg.screenshot(path=shot, full_page=True)
    m = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    m.goto(url); m.wait_for_timeout(600)
    sw = m.evaluate("document.documentElement.scrollWidth")
    m.screenshot(path=shot.replace('.png', '-mobile.png'), full_page=False)
    print(json.dumps(info), 'mobile scrollWidth', sw)
    print('\n'.join(logs[:20]))
    b.close()
