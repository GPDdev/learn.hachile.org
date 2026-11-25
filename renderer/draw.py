"""Draw a structured lecture diagram and animate the highlighted relationship."""
import math
import os
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 960, 540
PAPER, INK, MUTE, ACCENT = "#f6f4ed", "#153d37", "#516f64", "#bde69b"


@lru_cache(maxsize=16)
def font(size):
    candidates = [os.getenv("FONT_PATH", ""), "C:/Windows/Fonts/msyh.ttc",
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"]
    for f in candidates:
        if f and Path(f).is_file():
            return ImageFont.truetype(f, size)
    raise RuntimeError("Set FONT_PATH to a Chinese typeface")


def wrapped(draw, text, width, size):
    lines, current = [], ""
    for ch in text:
        if current and draw.textlength(current + ch, font=font(size)) > width:
            lines.append(current)
            current = ""
        current += ch
    return lines + ([current] if current else [])


def layout(plan, scene, caption, index, beat, nbeats, demo):
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    d.text((34, 15), "AI 视频课堂", font=font(18), fill=INK)
    d.text((W-35, 21), "本机示例" if demo else "AI 生成", anchor="ra", font=font(14), fill=MUTE)
    d.line((34, 51, W-34, 51), fill="#cfdbce", width=2)
    for n, line in enumerate(wrapped(d, scene["title"], 865, 35)[:2]):
        d.text((35, 64+n*40), line, font=font(35), fill=INK)
    desc = plan["title"][:38]+"    /    "+str(index+1)+" / "+str(len(plan["scenes"]))
    d.text((37, 134), desc, font=font(16), fill=MUTE)
    d.rounded_rectangle((34,174,926,386),radius=15,fill="#143d36")
    for x in range(56,925,30):
        for y in range(195,385,26):
            d.point((x,y), fill="#42655a")
    labels=scene["labels"]
    nodes=[(int(160+i*635/(len(labels)-1)),270) for i in range(len(labels))]
    visual=scene.get("visual","flow")
    if visual in ("orbit","cycle","rings"):
        nodes=[(int(479+282*math.cos(math.pi+i*2*math.pi/len(labels))),
                int(269+45*math.sin(math.pi+i*2*math.pi/len(labels)))) for i in range(len(labels))]
        d.ellipse((197,224,761,314),outline="#87aba0",width=2)
        d.ellipse((420,210,538,328),fill="#ccd8a3")
        if visual=="rings":
            d.arc((379,240,579,305),0,182,fill="#f5d6a5",width=7)
    else:
        for i in range(len(nodes)-1):
            x,y=nodes[i]
            nx,ny=nodes[i+1]
            d.line((x,y,nx,ny),fill="#739b8c",width=3)
            if visual=="network":
                for dy in (-46,46):
                    cx=(x+nx)//2
                    d.line((x,y,cx,y+dy,nx,ny),fill="#668e80",width=2)
                    d.ellipse((cx-6,y+dy-6,cx+6,y+dy+6),fill="#afc9ad")
    active=min(len(labels)-1,beat*len(labels)//max(1,nbeats))
    for i,((x,y),label) in enumerate(zip(nodes,labels)):
        r=16 if i==active else 10
        d.ellipse((x-r,y-r,x+r,y+r),fill=ACCENT if i==active else "#86aa9a")
        label_lines=wrapped(d,label,175,17)
        for k,line in enumerate(label_lines[:2]):
            d.text((x,y+25+19*k),line,anchor="ma",font=font(17),fill="white")
    for i,line in enumerate(wrapped(d,caption,864,23)[:3]):
        d.text((W//2,408+i*30),line,anchor="ma",font=font(23),fill=INK)
    d.line((34,517,926,517),fill="#cbd7ca",width=3)
    return im,nodes,visual


def animated(base,nodes,visual,progress,course_progress):
    im=base.copy()
    d=ImageDraw.Draw(im)
    if visual in ("orbit","cycle","rings"):
        a=math.pi+2*math.pi*progress
        x,y=479+282*math.cos(a),269+45*math.sin(a)
    else:
        v=progress*(len(nodes)-1)
        i=min(len(nodes)-2,int(v))
        x,y=nodes[i]
        nx,ny=nodes[i+1]
        x,y=x+(nx-x)*(v-i),y+(ny-y)*(v-i)
    d.ellipse((int(x)-5,int(y)-5,int(x)+5,int(y)+5),fill="#fff4c9")
    d.line((34,517,34+int(892*course_progress),517),fill="#396e57",width=4)
    return im
