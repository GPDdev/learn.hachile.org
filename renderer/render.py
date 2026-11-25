import json
import math
import subprocess
import tempfile
from pathlib import Path

from draw import W,H,layout,animated
from speech import voices,captions

FPS=12


def probe(file):
    p=subprocess.run(["ffprobe","-v","error","-show_format","-show_streams","-of","json",str(file)],
                     capture_output=True,check=True,text=True,encoding="utf8",timeout=25)
    return json.loads(p.stdout)


def run_ff(args):
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y",*args],check=True,timeout=300)


def render(plan, target, cloud=False):
    target=Path(target).resolve()
    target.parent.mkdir(parents=True,exist_ok=True)
    scenes=plan["scenes"]
    if not 2<=len(scenes)<=9 or sum(len(s["narration"]) for s in scenes)>2200:
        raise ValueError("Invalid storyboard length")
    beats=[(i,j,len(parts),line) for i,scene in enumerate(scenes) for parts in [captions(scene["narration"])]
           for j,line in enumerate(parts)]
    with tempfile.TemporaryDirectory(prefix="classroom-render-") as temp:
        work=Path(temp)
        speech=voices([b[3] for b in beats],work,cloud)
        # Concatenate equal-format mono PCM, measuring actual samples for exact caption timings.
        import wave
        durations=[]
        master=work/"narration.wav"
        with wave.open(str(master),"wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(22050)
            for i,source in enumerate(speech):
                raw=subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-i",str(source),"-ac","1","-ar","22050","-f","s16le","-"],
                                   capture_output=True,check=True,timeout=25).stdout
                duration=len(raw)/44100
                if duration<=0 or duration>90:
                    raise ValueError("Invalid speech duration")
                wav.writeframes(raw)
                durations.append(duration)
        total=sum(durations)
        if total>900:
            raise ValueError("Lesson exceeds maximum playback length")
        cmd=["ffmpeg","-hide_banner","-loglevel","error","-y","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}",
             "-r",str(FPS),"-i","-","-i",str(master),"-c:v","libx264","-preset","veryfast","-threads","2","-crf","23",
             "-pix_fmt","yuv420p","-c:a","aac","-b:a","72k","-movflags","+faststart","-shortest",str(target)]
        proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
        elapsed=frames=0
        try:
            for (i,j,n,text),duration in zip(beats,durations):
                base,nodes,visual=layout(plan,scenes[i],text,i,j,n,not cloud)
                elapsed+=duration
                end=math.ceil(elapsed*FPS)
                start=frames
                while frames<end:
                    p=(j+(frames-start)/max(1,end-start))/n
                    frame=animated(base,nodes,visual,p,min(1,frames/FPS/total))
                    proc.stdin.write(frame.tobytes())
                    frames+=1
            proc.stdin.close()
            if proc.wait(timeout=90)!=0:
                raise RuntimeError("Video encoding failed")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        result=probe(target)
        if {s["codec_name"] for s in result["streams"]}!={"h264","aac"}:
            raise RuntimeError("MP4 stream check failed")
        return float(result["format"]["duration"])
