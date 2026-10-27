// Fit body modal masses so the model's Re Yzz at real partial frequencies matches the inferred values (band medians).
import { readFileSync } from 'fs';
await import('../src/modal.js');
const rows = JSON.parse(readFileSync('/tmp/claude-0/out/reY.json'));
const bands = [[70,150],[150,300],[300,600],[600,1200],[1200,2400],[2400,5000],[5000,9000]];
const target = bands.map(([lo,hi]) => { const v = rows.filter(r => r[0]>=lo && r[0]<hi).map(r => Math.max(r[6],1e-5)).sort((a,b)=>a-b); return v.length ? v[Math.floor(v.length/2)] : null; });
const fs = rows.map(r => r[0]);
const E = new GuitarEngine(48000);
const spec = JSON.parse(JSON.stringify(GUITAR_PRESETS.dreadnought.body));
const med = (b) => { const Y = new Float64Array(6); const v = fs.filter(f=>f>=bands[b][0]&&f<bands[b][1]).map(f => (E.body.Y(2*Math.PI*f, Y), Y[4])).sort((a,b)=>a-b); return v.length ? v[Math.floor(v.length/2)] : null; };
for (let it = 0; it < 12; it++) {
  E.setParams({ override: { body: spec } });
  const m = bands.map((_, b) => med(b));
  if (it === 0 || it === 11) console.log('iter', it, bands.map((b,i)=>`${b[0]}-${b[1]}: model ${m[i]?.toFixed(4)} target ${target[i]?.toFixed(4)}`).join(' | '));
  for (let b = 0; b < bands.length; b++) {
    if (!m[b] || !target[b]) continue;
    const r = Math.pow(m[b] / target[b], 0.7); // ReY ~ 1/m
    spec.modes.forEach(md => { if (md[0] >= bands[b][0] && md[0] < bands[b][1]) md[2] *= r; });
    if (bands[b][0] >= 600) { const H = spec.hf; const lo = Math.log(H.f0), hi = Math.log(H.f1);
      const t0 = (Math.log(Math.max(bands[b][0],H.f0)) - lo)/(hi-lo), t1 = (Math.log(Math.min(bands[b][1],H.f1)) - lo)/(hi-lo);
      // adjust the mass ramp endpoints toward this band
      if (t1 > 0 && t0 < 1) { const mid = (t0+t1)/2; H.mlo *= Math.pow(r, 1-mid); H.mhi *= Math.pow(r, mid); } }
  }
}
console.log(JSON.stringify({ modes: spec.modes.map(m => m.map(x => +x.toFixed(3))), hf: spec.hf }));
