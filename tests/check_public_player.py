"""Play and seek each public sample in a real browser using the production domain."""

import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


origin = "https://learn.hachile.org"
samples = json.loads((Path(__file__).resolve().parents[1] / "public/samples.json").read_text(encoding="utf-8"))

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
        page.wait_for_function("document.querySelector('video').currentTime > 0.25")
        duration = player.evaluate("(v) => { v.currentTime = v.duration / 2; return v.duration; }")
        page.wait_for_function("""() => {
            const v = document.querySelector('video');
            return !v.seeking && !v.paused && v.currentTime > v.duration / 2 + 0.25;
        }""")
        print(f"{sample['id']}: played and sought to the midpoint of {duration:.1f}s.", flush=True)
    browser.close()
