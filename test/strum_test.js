require('../src/strum.js');
const open=[40,45,50,55,59,64];
const N=n=>{const m=n.match(/^([A-G]#?)(\d)$/);return 12*(+m[2]+1)+['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].indexOf(m[1]);};
const show=f=>f.map(x=>x<0?'x':x).join(f.some(x=>x>9)?'-':'');
const cases={C:'C3 E3 G3 C4',G:'G2 B3 D4 G4',Am:'A2 C4 E4',D:'D3 F#3 A3 D4',F:'F2 A3 C4 F4',Em:'E2 G3 B3',Cmaj7:'C3 E3 G3 B3',Dm7:'D3 F3 A3 C4',Bm:'B2 D4 F#4'};
console.log('chord   played    guitarize');
for(const [k,v] of Object.entries(cases)){const n=v.split(' ').map(N);console.log(k.padEnd(7),show(voicePlayed(n,open,0).frets).padEnd(9),show(voiceGuitarize(n,open,0).frets));}
// triad in one octave from a keyboardist
for(const [k,v] of Object.entries({C:'C4 E4 G4',G:'G3 B3 D4',Am:'A3 C4 E4',F:'F3 A3 C4',E7:'E3 G#3 B3 D4'})){const n=v.split(' ').map(N);console.log('triad',k.padEnd(4),show(voicePlayed(n,open,0).frets).padEnd(9),show(voiceGuitarize(n,open,0).frets));}
// strum timing + pendulum
let t=0; const evs=[]; const se=new StrumEngine({send:e=>evs.push(...e),now:()=>t,options:{voicing:'guitarize'},rng:(()=>{let s=7;return()=>(s=(s*16807)%2147483647)/2147483647})()});
let tq=[]; global.setTimeout=(f)=>{tq.push(f);return tq.length}; global.clearTimeout=()=>{}; const runT=()=>{const q=tq;tq=[];q.forEach(f=>f());};
const times=[0,0.6,1.2,1.5,1.8,2.1,2.25,2.4,4.0];
const dirs=[];
for(const tt of times){t=tt; evs.length=0; ['C3','E3','G3','C4'].forEach(n=>se.noteOn(N(n),0.8,tt)); runT(); const p=evs.filter(e=>e.type==='pluck'); dirs.push(p[0].dir>0?'D':'U'); if(tt===0||tt===1.5) console.log('t',tt,p.map(e=>`s${e.s}${e.dead?'(x)':''}@${((e.t-p[0].t)*1000).toFixed(1)}ms v${e.vel.toFixed(2)}`).join('  ')); ['C3','E3','G3','C4'].forEach(n=>se.noteOff(N(n))); runT();}
console.log('pendulum', times.map((x,i)=>x+':'+dirs[i]).join(' '));
