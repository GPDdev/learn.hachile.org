"""End-to-end test against an already running loopback classroom. Uses test-only identities."""
import os
import re
import time
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin=os.getenv("LEARN_TEST_ORIGIN","http://127.0.0.1:8787")
if not re.match(r"^http://(?:127\.0\.0\.1|localhost):\d+$",origin):
    raise SystemExit("Use the local classroom only.")
shots=Path(".local/qa")
shots.mkdir(parents=True,exist_ok=True)

def login(page,email):
    page.get_by_role("button",name="登录 / 注册").first.click()
    page.get_by_label("邮箱",exact=True).fill(email)
    page.get_by_role("button",name="获取验证码").click()
    otp=page.locator("#verify-code strong").inner_text()
    page.get_by_label("六位验证码").fill(otp)
    page.get_by_label("首次注册使用的昵称").fill("验收学习者")
    page.get_by_role("button",name="验证并登录").click()
    expect(page.locator("#dialog")).not_to_be_visible()

with sync_playwright() as p:
    binary=os.getenv("LEARN_TEST_BROWSER")
    if not binary and os.name=="nt":
        binary=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    browser=p.chromium.launch(executable_path=binary,headless=True)
    desk=browser.new_context(viewport={"width":1440,"height":960})
    guest=browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True)
    page=desk.new_page()
    mobile=guest.new_page()
    errors=[]
    for screen in (page,mobile):
        screen.on("pageerror",lambda err:errors.append(str(err)))
        screen.goto(origin,wait_until="networkidle")
        expect(screen.get_by_role("heading",name="今天，想学点什么？")).to_be_visible()
        assert screen.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.screenshot(path=str(shots/"desktop.png"))
    mobile.screenshot(path=str(shots/"mobile.png"))
    mobile.get_by_role("link",name=re.compile("土星环究竟")).first.click()
    assert mobile.locator("video").evaluate("(v)=>new Promise(r=>v.readyState>=1?r(v.duration):v.addEventListener('loadedmetadata',()=>r(v.duration),{once:true}))")>10
    login(page,"learn-"+uuid.uuid4().hex[:8]+"@classroom.test")
    page.locator("#topic").fill("土星环究竟是什么？")
    page.get_by_role("button",name="生成大纲").click()
    page.get_by_label("邀请码",exact=True).fill("CLASSROOM")
    page.get_by_role("button",name="激活邀请").click()
    expect(page.get_by_role("heading",name="课程大纲")).to_be_visible()
    page.get_by_role("button",name="确认生成视频").click()
    page.wait_for_url("**/lesson/*")
    job=page.url.rsplit("/",1)[1]
    assert guest.request.get(origin+"/api/jobs/"+job).status==404
    expect(page.locator("video")).to_be_visible(timeout=180000)
    assert page.locator("video").evaluate("(v)=>new Promise(r=>v.readyState>=1?r(v.duration):v.addEventListener('loadedmetadata',()=>r(v.duration),{once:true}))")>10
    media=page.request.get(origin+"/api/jobs/"+job+"/media",headers={"Range":"bytes=0-63"})
    assert media.status==206 and b"ftyp" in media.body()
    page.get_by_role("button",name="发布到社区").click()
    expect(page.get_by_role("button",name="撤回公开作品")).to_be_visible()
    mobile.goto(origin+"/community")
    mobile.get_by_role("link",name=re.compile("土星环究竟")).first.click()
    expect(mobile.locator("video")).to_be_visible()
    assert guest.request.get(origin+"/api/jobs/"+job+"/media",headers={"Range":"bytes=0-63"}).status==206
    page.get_by_role("button",name="撤回公开作品").click()
    expect(page.get_by_role("button",name="发布到社区")).to_be_visible()
    assert guest.request.get(origin+"/api/jobs/"+job+"/media").status==404
    page.get_by_role("link",name="积分钱包",exact=True).click()
    page.get_by_role("button",name="测试充值",exact=True).click()
    page.get_by_role("button",name="取消",exact=True).click()
    expect(page.get_by_text("已取消",exact=True)).to_be_visible()
    page.get_by_role("button",name="测试充值",exact=True).click()
    page.get_by_role("button",name="确认模拟支付").click()
    expect(page.get_by_text("支付测试余额 100 积分")).to_be_visible()
    login(mobile,"learn-"+uuid.uuid4().hex[:8]+"@classroom.test")
    assert guest.request.get(origin+"/api/jobs/"+job+"/media").status==404
    page.get_by_role("link",name="学习工作台",exact=True).click()
    page.get_by_role("button",name="天文学入门",exact=True).click()
    page.get_by_role("button",name="生成大纲").click()
    expect(page.get_by_role("heading",name="课程大纲")).to_be_visible()
    assert page.locator(".outline li").count()==5
    page.get_by_label("想怎样调整？").fill("先讲第2段")
    page.get_by_role("button",name="更新大纲").click()
    expect(page.locator(".outline li strong").first).to_have_text("一颗恒星和它的邻居")
    page.get_by_role("button",name="确认生成视频").click()
    expect(page.locator("video")).to_be_visible(timeout=180000)
    assert not errors, errors
    browser.close()
    print("Browser checks passed: desktop, mobile, login, invitation, narrated MP4, publish/withdraw, private access, test wallet.")
