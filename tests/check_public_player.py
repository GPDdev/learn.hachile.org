"""Play and seek each public sample in a real browser using the production domain."""

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


origin = "https://learn.hachile.org"
samples = json.loads((Path(__file__).resolve().parents[1] / "public/samples.json").read_text(encoding="utf-8"))


def wait_for_playback(player, start):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        position, seeking, paused, error = player.evaluate("(v) => [v.currentTime, v.seeking, v.paused, v.error?.message]")
        assert not error, error
        if not seeking and not paused and position > start + 0.25:
            return
        time.sleep(0.1)
    raise AssertionError(f"Playback did not advance past {start:.1f}s; last position {position:.1f}s")


with sync_playwright() as playwright:
    channel = "msedge" if sys.platform == "win32" else "chrome"
    browser = playwright.chromium.launch(channel=channel)
    page = browser.new_page()
    page.goto(origin)
    expect(page.get_by_role("heading", name="今天，想学点什么？")).to_be_visible()
    for sample in samples:
        page.goto(origin + "/community")
        page.locator(f'a[href="/sample/{sample["id"]}"]').first.click()
        expect(page.get_by_role("heading", name=sample["title"])).to_be_visible()
        player = page.locator("video")
        player.evaluate("(v) => { v.muted = true; return v.play(); }")
        wait_for_playback(player, 0)
        duration = player.evaluate("(v) => { v.currentTime = v.duration / 2; return v.duration; }")
        wait_for_playback(player, duration / 2)
        print(f"{sample['id']}: played and sought to the midpoint of {duration:.1f}s.", flush=True)
    browser.close()
