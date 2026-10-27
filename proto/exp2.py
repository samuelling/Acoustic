import json, sys, subprocess, copy
from synth_note import render, DEFAULT
O='/tmp/claude-0/out/'
def run(tag, cfg):
    for s,n in [(0,'E2'),(2,'D3'),(5,'E4')]: render(s,0,O+tag+'_'+n+'.wav',cfg)
    print('==',tag); sys.stdout.flush()
    subprocess.run(['python3','score.py',O+tag],stderr=subprocess.DEVNULL)
cfg=copy.deepcopy(DEFAULT); cfg['hf'].update(mlo=1.5,mhi=8.0); cfg['modes']=[(f,q,m*2.5,g) for f,q,m,g in cfg['modes']]; cfg['cross']=0.35
run('m3',cfg)
cfg2=copy.deepcopy(DEFAULT); cfg2['hf'].update(mlo=0.8,mhi=4.0); cfg2['modes']=[(f,q,m*1.5,g) for f,q,m,g in cfg2['modes']]; cfg2['cross']=0.35
run('m4',cfg2)
