"""Verify every shipped sample is decodable, narrated, and has an accurate duration."""
import json
import subprocess
from pathlib import Path

public=Path(__file__).resolve().parents[1]/"public"
samples=json.loads((public/"samples.json").read_text(encoding="utf8"))
durations=json.loads((public/"media/durations.json").read_text(encoding="utf8"))
assert {s["id"] for s in samples}==set(durations)
for sample in samples:
    key=sample["id"]
    file=public/"media"/(key+".mp4")
    p=subprocess.run(["ffprobe","-v","error","-of","json","-show_format","-show_streams",str(file)],capture_output=True,text=True,check=True)
    result=json.loads(p.stdout)
    assert {s["codec_name"] for s in result["streams"]}=={"h264","aac"}
    assert abs(float(result["format"]["duration"])-durations[key])<0.15
    subprocess.run(["ffmpeg","-v","error","-xerror","-i",str(file),"-f","null","-"],check=True)
    cover="saturn" if key=="rings" else key
    assert (public/"media"/(cover+".jpg")).stat().st_size>1000
    print(key,round(durations[key],1),"seconds: video and audio decoded")
