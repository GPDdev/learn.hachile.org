"""Authenticated Function Compute event handler and loopback development worker."""
import argparse
import json
import os
import sys
import tempfile
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

import requests

from render import render


def process(job,token,origin,cloud):
    started=time.monotonic()
    base=origin+"/api/internal/render/"+job+"/"
    run=uuid.uuid4().hex
    headers={"Authorization":"Bearer "+token,"X-Render-Run":run}
    claim=requests.post(base+"claim",json={"run":run},headers=headers,timeout=20)
    claim.raise_for_status()
    data=claim.json()
    if data.get("skip"):
        return
    try:
        with tempfile.TemporaryDirectory(prefix="lesson-") as tmp:
            target=Path(tmp)/"lesson.mp4"
            duration=render(data["plan"],target,cloud)
            # A retry only retransmits the existing file; narration and encoding are performed once.
            for attempt in range(3):
                try:
                    with target.open("rb") as f:
                        r=requests.post(base+"upload",data=f,headers={**headers,"Content-Type":"video/mp4"},timeout=90)
                        r.raise_for_status()
                    break
                except requests.RequestException:
                    if attempt==2:
                        raise
            for attempt in range(3):
                try:
                    r=requests.post(base+"finish",json={"duration":duration,"elapsed":max(1,time.monotonic()-started)},headers=headers,timeout=15)
                    r.raise_for_status()
                    break
                except requests.RequestException:
                    if attempt==2:
                        raise
    except Exception:
        try:
            requests.post(base+"fail",json={},headers=headers,timeout=12)
        finally:
            raise


class EventHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path!="/invoke":
            self.send_error(404)
            return
        try:
            size=int(self.headers.get("Content-Length","0"))
            if not 0<size<4096:
                raise ValueError("Invalid event size")
            event=json.loads(self.rfile.read(size))
            job=str(uuid.UUID(event["job_id"]))
            # FC InvokeFunction authenticates requests at the platform; the job-scoped callback
            # credential is additionally validated by the Classroom Worker before any paid call.
            origin=os.environ["CLASSROOM_ORIGIN"].rstrip("/")
            if urlparse(origin).scheme!="https":
                raise ValueError("HTTPS required")
            process(job,event["token"],origin,True)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        except Exception as error:
            print("Render invocation failed:",type(error).__name__,file=sys.stderr,flush=True)
            self.send_error(500)

    def do_GET(self):
        self.send_response(200 if self.path=="/health" else 404)
        self.end_headers()


def local_loop(origin, paid_models=False):
    if urlparse(origin).hostname not in ("127.0.0.1","localhost"):
        raise ValueError("Local renderer only accepts loopback")
    token=os.environ["LOCAL_RENDER_KEY"]
    print("Local Mandarin renderer ready",flush=True)
    while True:
        try:
            r=requests.post(origin+"/api/internal/render/local/next",headers={"Authorization":"Bearer "+token},timeout=8)
            r.raise_for_status()
            job=r.json()["id"]
            if job:
                process(job,token,origin,paid_models)
            else:
                time.sleep(2)
        except requests.ConnectionError:
            time.sleep(2)
        except Exception as error:
            print("Local render error:",type(error).__name__,str(error)[:220],file=sys.stderr,flush=True)
            time.sleep(3)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--local")
    parser.add_argument("--cloud-models", action="store_true")
    args=parser.parse_args()
    if args.local:
        local_loop(args.local.rstrip("/"), args.cloud_models)
    else:
        HTTPServer(("0.0.0.0",int(os.getenv("PORT","9000"))),EventHandler).serve_forever()
