"""Build the three bundled, editorial sample lessons with local Mandarin speech."""
import argparse
import json
import math
import random
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/"renderer"))
from render import render, probe


def covers(out):
    icon=Image.new("RGB",(96,96),"#15332e")
    art=ImageDraw.Draw(icon)
    art.polygon([(23,26),(54,18),(54,66),(23,74)],outline="#d0f58c",width=4)
    art.polygon([(40,33),(74,23),(74,65),(40,76)],fill="#d0f58c")
    icon.save(out/"icon.png")
    rng=random.Random(37)
    w,h=900,450
    im=Image.new("RGB",(w,h),"#102d3d")
    d=ImageDraw.Draw(im)
    for _ in range(900):
        x,y=rng.randrange(w),rng.randrange(h)
        c=rng.randrange(65,170)
        d.point((x,y),fill=(c,c+10,min(255,c+32)))
    for _ in range(18000):
        r=abs(rng.gauss(0,1))*150
        t=r/45+rng.choice([0,math.pi,math.pi/2,3*math.pi/2])+rng.gauss(0,.28)
        x,y=r*math.cos(t),r*math.sin(t)*.36
        xx,yy=450+x*.94+y*.34,220-x*.34+y*.94
        c=int(min(245,115+80*math.exp(-r/90)+rng.random()*35))
        d.point((int(xx),int(yy)),fill=(c,min(250,c+10),min(255,c+17)))
    im.save(out/"cosmos.jpg",quality=89)
    im=Image.new("RGB",(w,h),"#dedaf2")
    d=ImageDraw.Draw(im)
    pts=[[(145,140),(145,270)],[(345,85),(345,200),(345,320)],[(545,110),(545,240),(545,355)],[(735,160),(735,280)]]
    for group,other in zip(pts,pts[1:]):
        for a in group:
            for b in other:
                d.line((a,b),fill="#8c81aa",width=3)
    for group in pts:
        for x,y in group:
            d.ellipse((x-15,y-15,x+15,y+15),fill="#594878")
            d.ellipse((x-6,y-6,x+6,y+6),fill="#e1f3a0")
    im.save(out/"network.jpg",quality=92)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--only")
    args=parser.parse_args()
    out=root/"public"/"media"
    covers(out)
    samples=json.loads((root/"public"/"samples.json").read_text(encoding="utf8"))
    for sample in samples:
        if args.only and sample["id"]!=args.only:
            continue
        print(sample["id"],render(sample,out/(sample["id"]+".mp4")),flush=True)
    durations={s["id"]:float(probe(out/(s["id"]+".mp4"))["format"]["duration"]) for s in samples if (out/(s["id"]+".mp4")).is_file()}
    (out/"durations.json").write_text(json.dumps(durations,indent=2)+"\n",encoding="utf8")
