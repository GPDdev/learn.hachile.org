"""Synthesize each caption separately so its start and end match the audio."""
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import websocket


def captions(text, limit=42):
    chunks = []
    pending = ""
    for phrase in re.findall(r"[^。！？；，、,.!?;]+[。！？；，、,.!?;]*|[。！？；，、,.!?;]+", text):
        if len(pending) + len(phrase) > limit and pending:
            chunks.append(pending)
            pending = ""
        while len(phrase) > limit:
            chunks.append(phrase[:limit])
            phrase = phrase[limit:]
        pending += phrase
    if pending:
        chunks.append(pending)
    return chunks or [text]


def cosyvoice(text, path):
    key = os.environ["DASHSCOPE_API_KEY"]
    url = os.getenv("COSYVOICE_WS", "wss://dashscope.aliyuncs.com/api-ws/v1/inference")
    task = uuid.uuid4().hex
    ws = websocket.create_connection(url, timeout=45, header=["Authorization: Bearer " + key])

    def send(action, payload):
        ws.send(json.dumps({"header": {"action": action, "task_id": task, "streaming": "duplex"}, "payload": payload}))

    try:
        send("run-task", {"task_group": "audio", "task": "tts", "function": "SpeechSynthesizer",
             "model": "cosyvoice-v3-flash", "parameters": {"text_type": "PlainText", "voice": "longanyang",
             "format": "mp3", "sample_rate": 22050, "rate": 1, "pitch": 1}, "input": {}})
        with path.open("wb") as out:
            while True:
                message = ws.recv()
                if isinstance(message, bytes):
                    out.write(message)
                    continue
                event = json.loads(message)["header"]["event"]
                if event == "task-started":
                    send("continue-task", {"input": {"text": text}})
                    send("finish-task", {"input": {}})
                elif event == "task-finished":
                    break
                elif event == "task-failed":
                    raise RuntimeError("CosyVoice did not complete narration")
        if not path.stat().st_size:
            raise RuntimeError("Empty voice response")
    finally:
        ws.close()


def voices(lines, work, cloud):
    entries = [{"text": t, "file": str(work / ("speech-%03d." % i + ("mp3" if cloud else "wav")))}
               for i, t in enumerate(lines)]
    if cloud:
        for entry in entries:
            cosyvoice(entry["text"], Path(entry["file"]))
    elif sys.platform == "win32":
        manifest = work / "voices.json"
        manifest.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                        "-File", str(Path(__file__).with_name("voice.ps1")), str(manifest)], check=True, timeout=240)
    else:
        engine = shutil.which("espeak-ng") or shutil.which("espeak")
        if not engine:
            raise RuntimeError("Install espeak-ng for offline Mandarin narration")
        for entry in entries:
            subprocess.run([engine, "-v", "cmn" if engine.endswith("espeak-ng") else "zh", "-s", "145",
                            "-w", entry["file"], entry["text"]], check=True, timeout=30)
    return [Path(e["file"]) for e in entries]
