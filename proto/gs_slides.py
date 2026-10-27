"""Find finger slides in GuitarSet (Xi et al. 2018, CC BY 4.0) from the per-string pitch contours.

A slide: a continuously voiced run on one string (gaps < 20 ms) in which the pitch moves by >= 1.5 semitones
within <= 0.6 s, changing monotonically. Strings 0-3 (E A D G) are wound on GuitarSet's steel-string acoustic.
From the pitch we get where the stopping fret is, x = L (1 - f_open / f), and from its time course the hand speed.
usage: python3 -I proto/gs_slides.py <annotation dir> <out.json>
"""
import json, os, sys
import numpy as np

ann_dir, out = sys.argv[1], sys.argv[2]
OPEN = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63]
L = 0.645
slides = []
for fn in sorted(os.listdir(ann_dir)):
    j = json.load(open(os.path.join(ann_dir, fn)))
    for a in j['annotations']:
        if a['namespace'] != 'pitch_contour': continue
        s = int(a['annotation_metadata']['data_source'])
        if s > 3: continue
        t = np.array(a['data']['time']); v = a['data']['value']
        if len(t) < 10: continue
        f = np.array([x['frequency'] if x['voiced'] else 0 for x in v])
        # split into continuous voiced runs
        ok = f > 0
        runs, start = [], None
        for i in range(len(t)):
            if ok[i] and start is None: start = i
            if start is not None and (not ok[i] or i == len(t) - 1 or t[min(i + 1, len(t) - 1)] - t[i] > 0.02):
                end = i if ok[i] else i - 1
                if end - start > 8: runs.append((start, end))
                start = None
        for a0, a1 in runs:
            st = 12 * np.log2(f[a0:a1 + 1] / OPEN[s])     # semitones above the open string (fret, continuous)
            tt = t[a0:a1 + 1]
            # sliding windows: find stretches where the fret moves >= 1.5 within <= 0.6 s, monotonic
            i = 0
            while i < len(st) - 5:
                found = False
                for k in range(i + 5, len(st)):
                    if tt[k] - tt[i] > 0.6: break
                    d = st[k] - st[i]
                    if abs(d) >= 1.5:
                        seg = st[i:k + 1]
                        mono = np.all(np.diff(seg) * np.sign(d) > -0.15)
                        if mono:
                            # extend to where the motion settles (< 0.15 st change over 3 frames)
                            k2 = k
                            while k2 + 3 < len(st) and abs(st[k2 + 3] - st[k2]) > 0.15: k2 += 1
                            i0 = i
                            while i0 - 3 >= 0 and abs(st[i0] - st[i0 - 3]) > 0.15 and np.sign(st[i0] - st[i0 - 3]) == np.sign(d): i0 -= 1
                            seg_t, seg_s = tt[i0:k2 + 1], st[i0:k2 + 1]
                            x = L * (1 - 2 ** (-seg_s / 12))
                            v = np.gradient(x, seg_t)
                            dist = abs(seg_s[-1] - seg_s[0]); durS = seg_t[-1] - seg_t[0]
                            jump = np.max(np.abs(np.diff(seg_s))) if len(seg_s) > 1 else 9
                            # real slides: >= 2 semitones, 15-150 ms per semitone, no instantaneous jump (hammer-on/pull-off),
                            # plausible hand speed
                            if not (dist >= 2 and 0.015 <= durS / dist <= 0.15 and jump <= 1.2 and np.max(np.abs(v)) <= 2.5):
                                i = k2 + 1; found = True; break
                            slides.append({'file': fn.replace('.jams', ''), 'string': s, 't0': float(seg_t[0]), 't1': float(seg_t[-1]),
                                           'from': float(seg_s[0]), 'to': float(seg_s[-1]), 'peak_speed': float(np.max(np.abs(v))),
                                           'time': seg_t.tolist(), 'fret': seg_s.tolist()})
                            i = k2 + 1; found = True
                        break
                if not found: i += 1
json.dump(slides, open(out, 'w'))
d = np.array([s['t1'] - s['t0'] for s in slides]); sp = np.array([s['peak_speed'] for s in slides]); n = np.array([abs(s['to'] - s['from']) for s in slides])
print(len(slides), 'slides; per string', np.bincount([s['string'] for s in slides], minlength=4))
print('duration ms: median %.0f (10-90%%: %.0f-%.0f)' % (np.median(d) * 1e3, np.percentile(d, 10) * 1e3, np.percentile(d, 90) * 1e3))
print('distance frets: median %.1f (10-90%%: %.1f-%.1f)' % (np.median(n), np.percentile(n, 10), np.percentile(n, 90)))
print('peak hand speed m/s: median %.2f (10-90%%: %.2f-%.2f)' % (np.median(sp), np.percentile(sp, 10), np.percentile(sp, 90)))
