"""Check the public preview over HTTPS after a deployment."""

import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen


assets = Path(__file__).resolve().parents[1] / "public"
origin = "https://learn.hachile.org"


def read(path, headers=None):
    request = Request(origin + path, headers={"User-Agent": "Classroom release check", **(headers or {})})
    with urlopen(request, timeout=20) as response:
        assert response.geturl().startswith(origin + "/"), response.geturl()
        return response.status, response.headers, response.read()


def check_page(path):
    status, headers, body = read(path)
    assert status == 200 and headers.get_content_type() == "text/html", path
    assert "<title>AI 视频课堂</title>" in body.decode("utf-8"), path


check_page("/")
check_page("/community")
session = json.loads(read("/api/session")[2])
assert session["preview"] and not session["local"] and not session["paymentAvailable"], session
samples = json.loads((assets / "samples.json").read_text(encoding="utf-8"))
catalog = json.loads(read("/api/community")[2])["items"]
assert {course["id"] for course in catalog} == {sample["id"] for sample in samples}
assert all(course["sample"] for course in catalog)
print(f"Public catalog: {len(catalog)} sample courses, charging disabled.", flush=True)

for filename in ("app.js", "style.css", "samples.json"):
    published = read("/" + filename)[2].decode("utf-8").replace("\r\n", "\n")
    assert published == (assets / filename).read_text(encoding="utf-8"), filename

for sample in samples:
    ident = sample["id"]
    check_page("/sample/" + ident)
    media = f"/media/{ident}.mp4"
    status, headers, body = read(media)
    assert status == 200 and headers.get_content_type() == "video/mp4", media
    assert hashlib.sha256(body).digest() == hashlib.sha256((assets / media[1:]).read_bytes()).digest(), media
    status, headers, part = read(media, {"Range": "bytes=0-127"})
    assert status == 206 and headers["Content-Range"] == f"bytes 0-127/{len(body)}", media
    assert part == body[:128], media
    print(f"{ident}: {len(body)} bytes, content and byte range verified.", flush=True)
