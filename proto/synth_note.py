import numpy as np, sys, json, scipy.io.wavfile as w
from modal_proto import *
def make_body(cfg):
    return Body(cfg['modes'], hf=cfg['hf'], inplane=cfg.get('inplane',0.25), cross=cfg.get('cross',0.15))
DEFAULT=dict(modes=[(100,20,0.6,1.0),(188,25,0.07,0.8),(204,25,0.12,0.7),(245,30,0.3,0.3),(290,30,0.25,0.3),(380,35,0.15,0.4),(420,35,0.2,0.3),(505,40,0.15,0.3),(590,40,0.2,0.25),(680,40,0.2,0.25),(765,40,0.25,0.2),(880,45,0.25,0.2)],
  hf=dict(f0=950,f1=8000,count=60,qlo=30,qhi=80,mlo=0.4,mhi=3.0,g=0.15))
def render(s,fret,out,cfg=DEFAULT,xp=0.2,theta=0.3,tau=1.5e-4,dur=4.0,kind='steel'):
    body=make_body(cfg); sm=string_modes(s,fret,body,kind=kind)
    a=pluck(sm,xp,theta,tau_r=tau); Fy,Fz=synth_bridge_force(sm,a,dur)
    p=radiate(body,Fy,Fz,gy=0.3,Fs=static_force(sm,xp,theta,0.002) if cfg.get('step',1) else (0,0))
    p/=np.abs(p).max()*1.1
    pad=np.zeros(int(0.05*SR)); p=np.concatenate([pad,p]).astype(np.float32)
    w.write(out,SR,p); return sm
if __name__=='__main__':
    cfg=DEFAULT
    if len(sys.argv)>3: cfg=json.loads(sys.argv[3])
    render(int(sys.argv[1]),0,sys.argv[2],cfg)
