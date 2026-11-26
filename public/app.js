const main = document.querySelector('main'),
  dialog = document.querySelector('#dialog'),
  body = document.querySelector('#dialog-body');
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const h = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => escapeMap[c]);
const icons = {
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  play: 'm9 5 10 7-10 7z',
  book: 'M3 5c3-1 6 0 9 2v13c-3-2-6-3-9-2zm18 0c-3-1-6 0-9 2v13c3-2 6-3 9-2z',
  atom: 'M3 12c0-5 18-5 18 0s-18 5-18 0zm5-8c5-3 13 13 8 16S3 7 8 4z',
  film: 'M3 5h18v14H3zm4 0v14m10-14v14M3 10h4m10 0h4',
  people: 'M4 21v-3c0-5 12-5 12 0v3M6 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0m11 4q5 1 5 7',
  back: 'm11 5-7 7 7 7M5 12h15',
  layers: 'm3 8 9-5 9 5-9 5zM3 12l9 5 9-5m-18 4 9 5 9-5',
  spark: 'm12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z',
};
const icon = (k) =>
  '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="' + icons[k] + '"/></svg>';
const link = (path, label, cls = 'text-link') =>
  '<a data-nav class="' + cls + '" href="' + h(path) + '">' + label + '</a>';
const btn = (action, label, cls = 'secondary', attrs = '') =>
  '<button type="button" class="' +
  cls +
  '" data-action="' +
  action +
  '" ' +
  attrs +
  '>' +
  label +
  '</button>';
const typeName = (k) => (k === 'overview' ? '领域概览' : '知识点讲解');
const duration = (s) =>
  Math.floor(Math.round(s) / 60) + ':' + String(Math.round(s) % 60).padStart(2, '0');
const date = (t) =>
  new Date(t * 1000).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const stateLabel = {
  queued: '等待生成',
  dispatched: '已排入渲染队列',
  rendering: '正在配音和绘制动画',
  ready: '已完成',
  failed: '生成失败',
};
let session = { user: null },
  samples = [],
  meta = {},
  kind = 'point',
  draft = null,
  content = '',
  level = '零基础',
  continuing = null,
  timer,
  generation = 0,
  noticeTimer,
  filter = 'all',
  query = '',
  busy = false;
async function api(path, data) {
  const r = await fetch('/api/' + path, {
    method: data == null ? 'GET' : 'POST',
    headers: data == null ? {} : { 'Content-Type': 'application/json' },
    body: data == null ? undefined : JSON.stringify(data),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || '请求失败，请重试');
  return value;
}
async function refreshSession() {
  session = await api('session');
  document.documentElement.toggleAttribute('data-public-preview', !!session.preview);
  document.querySelector('#account').textContent = session.user ? session.user.name : '登录 / 注册';
}
function notice(message) {
  const el = document.querySelector('#notice');
  el.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.textContent = ''), 4500);
}
function modal(title, html) {
  document.querySelector('#dialog-title').textContent = title;
  body.innerHTML = html;
  if (!dialog.open) dialog.showModal();
}
function showError(error) {
  const msg = error.message || String(error);
  if (dialog.open) {
    let e = body.querySelector('[role=alert]');
    if (!e) {
      e = document.createElement('p');
      e.setAttribute('role', 'alert');
      e.className = 'status error space';
      body.append(e);
    }
    e.textContent = msg;
  } else notice(msg);
}
function navigate(path) {
  if (dialog.open) dialog.close();
  history.pushState(null, '', path);
  window.scrollTo(0, 0);
  page().catch(showError);
}
function empty(title, subtitle, action = '') {
  return (
    '<div class="empty"><span class="badge-icon">' +
    icon('film') +
    '</span><div><strong>' +
    h(title) +
    '</strong><p>' +
    h(subtitle) +
    '</p></div>' +
    action +
    '</div>'
  );
}
function heading(title, subtitle = '') {
  return (
    '<header class="page-head"><h1>' +
    h(title) +
    '</h1>' +
    (subtitle ? '<p>' + h(subtitle) + '</p>' : '') +
    '</header>'
  );
}
function sampleCard(s) {
  return link(
    '/sample/' + s.id,
    '<div class="cover ' +
      (s.id === 'rings' ? 'saturn' : '') +
      '"><img src="/media/' +
      (s.id === 'rings' ? 'saturn' : s.id) +
      '.jpg" alt=""><span class="time">' +
      duration(meta[s.id] || 0) +
      '</span></div><div class="card-body"><div class="card-meta"><span class="tag">' +
      typeName(s.kind) +
      '</span>' +
      h(s.subject) +
      '</div><h3>' +
      h(s.title) +
      '</h3><p>' +
      h(s.summary) +
      '</p></div>',
    'card',
  );
}
function videoCard(v) {
  return link(
    '/lesson/' + encodeURIComponent(v.id),
    '<div class="cover auto-cover">' +
      icon(v.kind === 'overview' ? 'layers' : 'atom') +
      '<span class="time">' +
      duration(v.seconds) +
      '</span></div><div class="card-body"><div class="card-meta"><span class="tag">' +
      typeName(v.kind) +
      '</span>' +
      h(v.author) +
      '</div><h3>' +
      h(v.title) +
      '</h3><p>' +
      h(
        v.state === 'ready'
          ? v.blocked
            ? '已下架'
            : v.published
              ? '已公开'
              : '仅自己可见'
          : stateLabel[v.state],
      ) +
      '</p></div>',
    'card',
  );
}
function login(next) {
  continuing = next || null;
  modal(
    '登录 AI 视频课堂',
    '<form id="send-code" class="stack"><p class="muted">使用邮箱验证码登录，首次登录会创建独立的课堂账号。</p><label class="field">邮箱<input name="email" type="email" required autocomplete="email" placeholder="you@example.com"></label><button class="primary">获取验证码</button></form>',
  );
}
function invite(next) {
  continuing = next || null;
  modal(
    '激活内测邀请',
    '<form id="invite" class="stack"><p class="muted">激活后可获得 60 学习积分，用于生成自己的课程。</p>' +
      (session.local ? '<p class="status">本机体验邀请码为 CLASSROOM。</p>' : '') +
      '<label class="field">邀请码<input name="code" required maxlength="100"></label><button class="primary">激活邀请</button></form>',
  );
}
async function gate(next) {
  if (!session.user) return login(() => gate(next));
  if (!session.user.canGenerate) return invite(next);
  return next();
}
function account() {
  if (!session.user) return login(() => page());
  const u = session.user;
  modal(
    u.name,
    '<div class="stack"><p>' +
      h(u.email) +
      '</p><p class="status">可用学习积分 <strong>' +
      u.balances.learn +
      '</strong></p><div class="actions">' +
      link('/wallet', '查看钱包', 'secondary') +
      (u.canGenerate ? '' : btn('invite', '激活邀请')) +
      (u.admin ? link('/admin', '内容管理', 'secondary') : '') +
      btn('logout', '退出登录', 'secondary') +
      '</div></div>',
  );
}
function modes() {
  return ['point', 'overview']
    .map((k) =>
      btn(
        'kind',
        icon(k === 'point' ? 'atom' : 'layers') + typeName(k),
        '',
        'data-kind="' + k + '" aria-pressed="' + (kind === k) + '"',
      ),
    )
    .join('');
}
function topicForm() {
  return '<p>说说你想探索的领域，或直接问一个知识点。</p><form class="composer" id="ask"><textarea name="topic" id="topic" required minlength="2" maxlength="240" aria-label="学习主题" placeholder="例如，土星的环究竟是什么？">' +
    h(content) +
    '</textarea><div class="composer-row"><div class="modes">' +
    modes() +
    '</div><button class="primary">生成大纲 ' +
    icon('arrow') +
    '</button></div></form><div class="ideas"><span>' +
    (session.offline ? '可体验' : '试试') +
    '</span>' +
    samples
      .map((s) =>
        btn(
          'idea',
          h(s.id === 'rings' ? '土星环' : s.id === 'cosmos' ? '天文学入门' : '手写数字识别'),
          '',
          'data-sample="' + s.id + '"',
        ),
      )
      .join('') +
    '<label class="level-choice">学习基础<select id="initial-level">' +
    ['零基础', '已有基础', '进阶学习']
      .map((x) => '<option ' + (x === level ? 'selected' : '') + '>' + x + '</option>')
      .join('') +
    '</select></label></div>';
}
async function home(seq) {
  const status = session.preview ? '公开试看' : session.offline ? '本机示例模式' : session.user?.canGenerate ? '视频生成可用' : '邀请内测';
  const intro = session.preview
    ? '<p>看看土星环由什么组成，或跟着动画了解神经网络怎样认出手写数字。</p><div class="actions space"><a class="primary" href="#samples">挑一堂课 ' + icon('arrow') + '</a></div>'
    : topicForm();
  main.innerHTML =
    '<section class="hero"><div class="hero-art" aria-hidden="true"><div class="starfield"></div><img src="/media/saturn.jpg" alt=""></div><div class="hero-content"><div class="eyebrow"><span class="signal"></span>' +
    status + '</div><h1>今天，想学点什么？</h1>' + intro + '</div>' +
    link('/sample/rings', '<i>' + icon('play') + '</i> 观看土星环示例课', 'hero-preview') +
    '</section><section class="section" id="samples"><div class="section-head"><div><h2>示例课程</h2><p>' +
    (session.preview ? '三堂课程均可直接播放。账号注册、个人创作和积分充值尚未开放。' : '先看一堂课，了解配音动画的讲解方式。') +
    '</p></div></div><div class="cards">' +
    samples.map(sampleCard).join('') +
    '</div></section>' +
    (session.preview ? '' : '<section class="section"><div class="section-head"><div><h2>社区新课</h2></div>' +
    link('/community', '浏览社区 ' + icon('arrow')) +
    '</div><div id="community-preview"></div></section>');
  if (session.preview) return;
  try {
    const { items } = await api('community');
    if (seq === generation)
      document.querySelector('#community-preview').innerHTML = items.length
        ? '<div class="cards">' + items.slice(0, 3).map(videoCard).join('') + '</div>'
        : empty('社区正在等第一堂课', '完成自己的视频后，可以选择把它发布在这里。');
  } catch {
    if (seq === generation)
      document.querySelector('#community-preview').innerHTML = empty(
        '暂时无法读取社区',
        '稍后重新打开社区即可重试。',
      );
  }
}
function draftPage() {
  if (!draft && session.user) {
    try {
      draft = JSON.parse(sessionStorage.getItem('outline:' + session.user.id) || 'null');
    } catch {}
  }
  if (!draft) {
    main.innerHTML =
      heading('课程大纲') +
      empty(
        '还没有待确认的大纲',
        '先从一个想学的问题开始。',
        link('/', '去学习工作台', 'secondary'),
      );
    return;
  }
  const p = draft.lesson;
  main.innerHTML =
    link('/', icon('back') + ' 学习工作台', 'backlink') +
    heading(p.title, p.summary) +
    '<div class="work-grid"><section class="panel"><h2>课程大纲</h2><div class="meta"><span class="tag">' +
    typeName(draft.kind) +
    '</span>' +
    h(draft.level) +
    '</div><ol class="outline">' +
    p.scenes
      .map((s) => '<li><strong>' + h(s.title) + '</strong><p>' + h(s.narration) + '</p></li>')
      .join('') +
    '</ol><form id="revise" class="stack"><label class="field">想怎样调整？<textarea name="feedback" required maxlength="400" placeholder="例如，再简短一点"></textarea></label><label class="field">学习基础<select name="level">' +
    ['零基础', '已有基础', '进阶学习']
      .map((x) => '<option ' + (draft.level === x ? 'selected' : '') + '>' + x + '</option>')
      .join('') +
    '</select></label><button class="secondary">更新大纲</button></form></section><aside class="panel stack"><h2>生成这堂课</h2><div><span class="price">' +
    draft.price +
    '</span> 积分</div><p>预计 ' +
    duration(draft.seconds) +
    '，每 6 秒 1 积分。确认后锁价，失败自动退回。</p><p class="fine">' +
    (draft.localDemo ? '本机示例分镜与系统中文语音。' : '千问分镜、中文配音和动画。') +
    '</p>' +
    btn('confirm', icon('film') + ' 确认生成视频', 'primary') +
    link('/wallet', '查看积分钱包') +
    '</aside></div>';
}
async function getQuote(feedback = '') {
  const result = await api('quotes', {
    topic: content,
    kind,
    level,
    feedback,
    previous: feedback ? draft?.id : undefined,
  });
  draft = result;
  sessionStorage.setItem('outline:' + session.user.id, JSON.stringify(result));
  navigate('/outline');
}
function watchLayout(title, summary, video, chapters, extra, aside) {
  return (
    heading(title, summary) +
    '<div class="work-grid"><div class="panel"><video class="player" controls playsinline preload="metadata" ' +
    video +
    '></video><div class="player-info">' +
    extra +
    '</div></div><aside class="panel"><h2>课程章节</h2><ol class="outline">' +
    chapters.map((s) => '<li>' + h(s) + '</li>').join('') +
    '</ol>' +
    aside +
    '</aside></div>'
  );
}
function samplePage(s) {
  if (!s) return notFound();
  main.innerHTML =
    link('/', icon('back') + ' 工作台', 'backlink') +
    watchLayout(
      s.title,
      s.summary,
      'src="/media/' +
        s.id +
        '.mp4" poster="/media/' +
        (s.id === 'rings' ? 'saturn' : s.id) +
        '.jpg"',
      s.scenes.map((x) => x.title),
      '<div class="meta"><span class="tag">课堂示例</span>' +
        typeName(s.kind) +
        ' / ' +
        h(s.subject) +
        '</div><p class="fine space">示例课程使用本机中文合成语音。' +
        (s.credit ? ' 封面来自 ' + h(s.credit) + '。' : '') +
        '</p><p class="fine">参考资料 ' +
        s.sources
          .map(
            (x) =>
              '<a class="source" href="' +
              h(x.url) +
              '" target="_blank" rel="noopener noreferrer">' +
              h(x.label) +
              '</a>',
          )
          .join(' ') +
        '</p>',
      session.preview ? link('/community', '浏览其他课程', 'secondary') : btn(
        'study',
        '从这个主题开始',
        'primary',
        'data-topic="' + h(s.title) + '" data-kind="' + s.kind + '"',
      ),
    );
}
async function lesson(key, seq) {
  const x = await api('jobs/' + encodeURIComponent(key));
  if (seq !== generation) return;
  const back = link(
    x.own ? '/library' : '/community',
    icon('back') + (x.own ? ' 我的视频' : ' 社区'),
    'backlink',
  );
  if (x.state !== 'ready') {
    main.innerHTML =
      back +
      heading(x.title) +
      empty(
        stateLabel[x.state],
        x.problem || '视频在后台生成，可以先离开，稍后从「我的视频」查看。',
      );
    if (x.state !== 'failed') timer = setTimeout(() => page().catch(showError), 3500);
    return;
  }
  const ops = x.own
    ? x.blocked
      ? '<span class="status">此作品已下架</span>'
      : btn(
          'publish',
          x.published ? '撤回公开作品' : '发布到社区',
          'primary',
          'data-id="' + key + '" data-publish="' + !x.published + '"',
        )
    : btn('report', '举报作品', 'secondary', 'data-id="' + key + '"');
  main.innerHTML =
    back +
    watchLayout(
      x.title,
      x.summary,
      'src="/api/jobs/' + key + '/media"',
      x.chapters,
      '<div class="meta"><span class="tag">AI 生成</span>' +
        h(x.author) +
        ' / ' +
        typeName(x.kind) +
        ' / ' +
        (x.published ? '社区公开' : '仅自己可见') +
        '</div><div class="actions space">' +
        ops +
        '</div>',
      x.followups.length
        ? '<h3>深入一个知识点</h3><div class="stack space">' +
            x.followups
              .map((k) =>
                btn('study', h(k), 'secondary', 'data-topic="' + h(k) + '" data-kind="point"'),
              )
              .join('') +
            '</div>'
        : '',
    );
}
let listItems = [],
  cursor = null;
function filteredList(mine) {
  const list = listItems.filter(
    (x) =>
      (filter === 'all' || x.kind === filter) &&
      (!query || x.title.toLowerCase().includes(query.toLowerCase())),
  );
  document.querySelector('#results').innerHTML = list.length
    ? '<div class="cards">' + list.map((v) => v.sample ? sampleCard(v) : videoCard(v)).join('') + '</div>'
    : empty(
        listItems.length ? '没有匹配的课程' : mine ? '还没有生成的视频' : '还没有公开的课程',
        listItems.length
          ? '换一个关键词或课程类型试试。'
          : mine
            ? '从一个想学的问题开始，完成的课程会保存在这里。'
            : '作者发布后，作品会出现在这里。',
        link('/', '去学习工作台', 'secondary'),
      );
  document.querySelector('#more').hidden = !cursor;
}
async function listing(mine, seq) {
  main.innerHTML = heading(
    mine ? '我的视频' : '课程社区',
    mine ? '查看生成进度，管理你的作品和公开状态。' : session.preview ? '本期开放三堂课堂示例。个人投稿将在创作功能开放后展示。' : '观看学习者主动公开的配音动画课。',
  );
  if (mine && !session.user) {
    main.innerHTML += empty(
      '登录后查看你的课程',
      '视频和生成进度会保存在自己的账号中。',
      btn('login', '登录 / 注册'),
    );
    return;
  }
  const data = await api(mine ? 'library' : 'community');
  if (seq !== generation) return;
  listItems = data.items;
  cursor = data.next;
  filter = 'all';
  query = '';
  main.innerHTML +=
    '<div class="searchbar"><input class="search" type="search" placeholder="搜索本页课程" aria-label="搜索本页课程"><div class="modes">' +
    [
      ['all', '全部'],
      ['overview', '领域概览'],
      ['point', '知识点'],
    ]
      .map(([v, k]) =>
        btn('filter', k, '', 'data-kind="' + v + '" aria-pressed="' + (v === 'all') + '"'),
      )
      .join('') +
    '</div></div><div id="results"></div><button id="more" class="secondary space" data-action="more">加载更多</button>';
  filteredList(mine);
}
let recharge = 10;
async function wallet(seq) {
  main.innerHTML = heading('积分钱包', '查看可用积分、充值订单和使用明细。');
  if (!session.user) {
    main.innerHTML += empty(
      '登录后管理积分',
      '生成前可查看报价，确认后才会冻结积分。',
      btn('login', '登录 / 注册'),
    );
    return;
  }
  const w = await api('wallet');
  if (seq !== generation) return;
  const mode = session.mode;
  main.innerHTML +=
    '<div class="work-grid"><section class="panel"><h2>学习积分</h2><p class="price">' +
    w.balances.learn +
    '</p><p class="fine">可用于生成视频的余额</p><p class="muted space">支付测试余额 ' +
    w.balances.sandbox +
    ' 积分</p><div class="list space">' +
    (w.history.length
      ? w.history
          .map(
            (x) =>
              '<div><span>' +
              h(x.note) +
              '<br><small class="fine">' +
              date(x.created) +
              '</small></span><strong>' +
              (x.amount > 0 ? '+' : '') +
              x.amount +
              '</strong></div>',
          )
          .join('')
      : '<p class="fine">暂无积分流水。</p>') +
    '</div></section><aside class="panel"><h2>充值积分</h2><p>1 元兑换 10 积分。</p><div class="tabs">' +
    [5, 10, 30]
      .map((v) =>
        btn('amount', '¥' + v, '', 'data-yuan="' + v + '" aria-pressed="' + (v === recharge) + '"'),
      )
      .join('') +
    '</div>' +
    (mode === 'live'
      ? ''
      : '<p class="status">' +
        (mode === 'local' ? '本机模拟支付' : '支付宝沙箱') +
        '。测试充值只进入测试余额。</p>') +
    '<div class="actions space">' +
    (session.paymentAvailable
      ? btn('pay', mode === 'live' ? '支付宝充值' : '测试充值', 'primary')
      : '<span class="fine">支付宝商户尚未开通</span>') +
    (!session.user.canGenerate ? btn('invite', '激活内测邀请') : '') +
    '</div></aside></div><section class="panel panels"><h2>充值订单</h2><div class="list">' +
    (w.orders.length
      ? w.orders
          .map(
            (o) =>
              '<div><span>¥' +
              o.fen / 100 +
              ' / ' +
              o.credits +
              ' 积分<br><small class="fine">' +
              date(o.created) +
              '</small></span><span>' +
              (o.state === 'paid'
                ? '已到账'
                : o.state === 'cancelled'
                  ? '已取消'
                  : btn('check-order', '查询待支付订单', 'secondary', 'data-id="' + o.id + '"')) +
              '</span></div>',
          )
          .join('')
      : '<p class="fine">暂无充值订单。</p>') +
    '</div></section>';
}
function notFound() {
  main.innerHTML = heading('课程页面不存在') + link('/', '返回工作台', 'secondary');
}
async function page() {
  const seq = ++generation;
  clearTimeout(timer);
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href') === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  try {
    if (session.preview && ['/outline', '/library', '/wallet', '/admin'].includes(path)) {
      main.innerHTML = heading('课堂公开试看') + empty('目前可以观看三堂示例课', '账号注册、视频创作和积分充值尚未开放。', link('/community', '选择课程', 'primary'));
      return;
    }
    if (path === '/') return await home(seq);
    if (path === '/outline') return draftPage();
    if (path === '/library' || path === '/community')
      return await listing(path === '/library', seq);
    if (path === '/wallet') return await wallet(seq);
    if (path.startsWith('/sample/'))
      return samplePage(samples.find((s) => s.id === path.split('/')[2]));
    if (/^\/lesson\/[a-f0-9-]+$/.test(path)) return await lesson(path.split('/')[2], seq);
    if (path === '/admin' && session.user?.admin) {
      const data = await api('admin/reports');
      if (seq !== generation) return;
      main.innerHTML =
        heading('内容管理') +
        '<div class="panel list">' +
        (data.items
          .map(
            (v) =>
              '<div><span>' +
              link('/lesson/' + v.id, h(v.title)) +
              '<br>' +
              h(v.reason) +
              '</span>' +
              (v.blocked ? '已下架' : btn('hide', '下架作品', 'danger', 'data-id="' + v.id + '"')) +
              '</div>',
          )
          .join('') || '暂无举报') +
        '</div>';
      return;
    }
    notFound();
  } catch (e) {
    if (seq === generation)
      main.innerHTML =
        heading('页面暂时无法打开') +
        empty(e.message, '可以返回工作台继续浏览。', link('/', '返回工作台', 'secondary'));
  }
}
async function followLogin() {
  const next = continuing;
  continuing = null;
  if (dialog.open) dialog.close();
  await refreshSession();
  if (next) await next();
  else await page();
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'topic') content = e.target.value;
  if (e.target.matches('.search')) {
    query = e.target.value;
    filteredList(location.pathname === '/library');
  }
});
document.querySelector('#account').onclick = account;
document.querySelector('#close-dialog').onclick = () => dialog.close();
window.addEventListener('popstate', () => {
  if (dialog.open) dialog.close();
  page().catch(showError);
});
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[data-nav]');
  if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
    return;
  }
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const { action, id: job } = b.dataset;
  b.disabled = true;
  try {
    switch (action) {
      case 'login':
        login(() => page());
        break;
      case 'invite':
        invite(() => page());
        break;
      case 'logout':
        await api('auth/logout', {});
        if (session.user) sessionStorage.removeItem('outline:' + session.user.id);
        draft = null;
        continuing = null;
        await refreshSession();
        navigate('/');
        break;
      case 'kind':
        kind = b.dataset.kind;
        document.querySelector('.composer .modes').innerHTML = modes();
        break;
      case 'idea': {
        const s = samples.find((x) => x.id === b.dataset.sample);
        content = s.title;
        kind = s.kind;
        document.querySelector('#topic').value = content;
        document.querySelector('.composer .modes').innerHTML = modes();
        document.querySelector('#topic').focus();
        break;
      }
      case 'study':
        content = b.dataset.topic;
        kind = b.dataset.kind;
        level = '零基础';
        navigate('/');
        break;
      case 'confirm': {
        const x = await api('jobs', { quote: draft.id });
        await refreshSession();
        navigate('/lesson/' + x.id);
        break;
      }
      case 'publish':
        await api('jobs/' + job + '/publish', { publish: b.dataset.publish === 'true' });
        await page();
        notice(b.dataset.publish === 'true' ? '作品已发布到社区' : '作品已撤回');
        break;
      case 'report':
        if (!session.user) {
          login(() => page());
          break;
        }
        modal(
          '举报作品',
          '<form id="report" data-id="' +
            h(job) +
            '" class="stack"><label class="field">举报理由<textarea name="reason" required minlength="2" maxlength="160"></textarea></label><button class="primary">提交举报</button></form>',
        );
        break;
      case 'hide':
        await api('admin/hide', { id: job });
        await page();
        break;
      case 'filter':
        filter = b.dataset.kind;
        document
          .querySelectorAll('[data-action=filter]')
          .forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.kind === filter)));
        filteredList(location.pathname === '/library');
        break;
      case 'more': {
        const mine = location.pathname === '/library';
        const x = await api(
          (mine ? 'library' : 'community') + '?before=' + encodeURIComponent(cursor),
        );
        listItems.push(...x.items);
        cursor = x.next;
        filteredList(mine);
        break;
      }
      case 'amount':
        recharge = Number(b.dataset.yuan);
        document
          .querySelectorAll('[data-action=amount]')
          .forEach((x) =>
            x.setAttribute('aria-pressed', String(Number(x.dataset.yuan) === recharge)),
          );
        break;
      case 'pay': {
        const x = await api('orders', {
          yuan: recharge,
          device: matchMedia('(max-width:680px)').matches ? 'mobile' : 'desktop',
        });
        if (x.mode === 'local') {
          modal(
            '本机模拟收银台',
            '<div class="stack"><p>模拟支付 ¥' +
              recharge +
              '，在测试钱包中增加 ' +
              recharge * 10 +
              ' 积分。</p><div class="actions">' +
              btn('local-pay', '确认模拟支付', 'primary', 'data-id="' + x.id + '"') +
              btn('cancel-pay', '取消', 'secondary', 'data-id="' + x.id + '"') +
              '</div></div>',
          );
        } else {
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = x.checkout.url;
          for (const [k, v] of Object.entries(x.checkout.fields)) {
            const f = document.createElement('input');
            f.type = 'hidden';
            f.name = k;
            f.value = v;
            form.append(f);
          }
          document.body.append(form);
          form.submit();
        }
        break;
      }
      case 'local-pay':
        await api('orders/' + job + '/local-pay', {});
        dialog.close();
        await refreshSession();
        await page();
        notice('测试积分已到账');
        break;
      case 'cancel-pay':
        await api('orders/' + job + '/local-cancel', {});
        dialog.close();
        await page();
        break;
      case 'check-order': {
        const x = await api('orders/' + job + '/check', {});
        await refreshSession();
        await page();
        notice(x.state === 'paid' ? '订单已到账' : '尚未收到付款');
        break;
      }
    }
  } catch (err) {
    showError(err);
  } finally {
    b.disabled = false;
  }
});
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !f.id) return;
  e.preventDefault();
  if (busy) return;
  busy = true;
  const b = f.querySelector('button[type=submit],button:not([type])'),
    original = b?.innerHTML;
  const d = Object.fromEntries(new FormData(f));
  if (b) {
    b.disabled = true;
    b.textContent = f.id === 'ask' || f.id === 'revise' ? '正在整理大纲…' : '请稍候…';
  }
  try {
    if (f.id === 'ask') {
      content = d.topic.trim();
      level = document.querySelector('#initial-level').value;
      await gate(() => getQuote());
    }
    if (f.id === 'revise') {
      content = draft.topic;
      kind = draft.kind;
      level = d.level;
      await gate(() => getQuote(d.feedback));
    }
    if (f.id === 'send-code') {
      const x = await api('auth/code', { email: d.email });
      modal(
        '验证邮箱',
        '<form id="verify-code" class="stack"><p class="muted">' +
          (x.localCode
            ? '本机验证码为 <strong>' + h(x.localCode) + '</strong>。'
            : '验证码已发往 ' + h(d.email) + '。') +
          '</p><input type="hidden" name="email" value="' +
          h(d.email) +
          '"><label class="field">六位验证码<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required></label><label class="field">首次注册使用的昵称<input name="name" maxlength="24" placeholder="学习者"></label><button class="primary">验证并登录</button></form>',
      );
    }
    if (f.id === 'verify-code') {
      await api('auth/verify', d);
      await followLogin();
    }
    if (f.id === 'invite') {
      await api('auth/invite', d);
      await followLogin();
    }
    if (f.id === 'report') {
      await api('jobs/' + f.dataset.id + '/report', d);
      dialog.close();
      notice('举报已提交');
    }
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    if (b) {
      b.disabled = false;
      b.innerHTML = original;
    }
  }
});
async function init() {
  const [s, m] = await Promise.all([
    fetch('/samples.json').then((r) => r.json()),
    fetch('/media/durations.json').then((r) => r.json()),
  ]);
  samples = s;
  meta = m;
  await refreshSession();
  await page();
  const order = new URLSearchParams(location.search).get('order');
  if (location.pathname === '/wallet' && session.user && /^[a-f0-9]{32}$/.test(order)) {
    try {
      const x = await api('orders/' + order + '/check', {});
      notice(x.state === 'paid' ? '充值已到账' : '付款结果待确认');
      await page();
    } catch (e) {
      showError(e);
    }
  }
}
init().catch((e) => {
  main.innerHTML = heading('课堂暂时无法打开') + empty(e.message, '请稍后刷新页面。');
});
