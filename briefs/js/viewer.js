// Viewer：未填表跳回 index；填了表展示简报 + 日期/班次切换
(function () {
  const TOKEN = localStorage.getItem('barry_token');
  const NAME  = localStorage.getItem('barry_name');

  if (!TOKEN) {
    location.href = './';
    return;
  }

  // 静默记录这次访问（失败不阻塞阅读）
  if (window.cbReady) {
    window.cbReady.then(cb => cb.callFunction({
      name: 'log_visit',
      data: { token: TOKEN, page: location.pathname, ua: navigator.userAgent },
    })).catch(() => {});
  }

  const PERIOD_LABELS = {
    morning: '早间',
    noon:    '午间',
    evening: '晚间',
    night:   '深夜',
  };
  // date 采用简报产出日期；深夜 01:30 是当天最早一份，不是最晚一份。
  const PERIOD_PRIORITY = ['evening', 'noon', 'morning', 'night'];

  let briefIndex = {};
  let currentPeriod = 'morning';

  // ── iframe 自适应高度 ────────────────────────────────────────────────
  // 简报是同源静态页，撑开 iframe 让正文在外层页面里连续流动，
  // 避免内层滚动条把正文截断、外层页脚提前出现。
  let frameLoadSeq = 0;   // 每次 load 自增，丢弃过期简报的延迟回调
  let resizeRaf = 0;      // resize 用 rAF 节流，不设任何全局定时器

  function getFrame() {
    return document.getElementById('brief-frame');
  }

  // 同时看 documentElement 与 body 的 scroll/offset 高度，取最大值兜底
  // （不同简报模板对 html/body 的高度设定不一致）
  function measureFrameHeight(frame) {
    const doc = frame.contentDocument;
    if (!doc) return 0;
    const de = doc.documentElement;
    const body = doc.body;
    const candidates = [
      de ? de.scrollHeight : 0,
      de ? de.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
    ];
    let max = 0;
    for (const v of candidates) {
      if (typeof v === 'number' && isFinite(v) && v > max) max = v;
    }
    return Math.ceil(max);
  }

  function resizeFrame() {
    const frame = getFrame();
    if (!frame) return;
    const prev = frame.style.height;
    try {
      // 先退回 CSS 基线高度再量，内容变矮时也能收回来
      frame.style.height = '';
      const h = measureFrameHeight(frame);
      if (h > 0) {
        frame.style.height = h + 'px';
      } else {
        frame.style.height = prev;
      }
    } catch (e) {
      // 跨域或文档不可访问：保持既有高度行为（CSS 的 min-height 仍生效）
      try { frame.style.height = prev; } catch (e2) {}
    }
  }

  function onFrameLoad() {
    const seq = ++frameLoadSeq;
    resizeFrame();

    // 简报页用自托管 Montserrat，字体落地后行高会变，量第二次
    try {
      const doc = getFrame() && getFrame().contentDocument;
      if (doc && doc.fonts && doc.fonts.ready && typeof doc.fonts.ready.then === 'function') {
        doc.fonts.ready
          .then(() => { if (seq === frameLoadSeq) resizeFrame(); })
          .catch(() => {});
      }
    } catch (e) { /* 跨域时忽略 */ }

    // 图片、延迟样式等排版落定后再量一次（一次性 timeout，非轮询）
    setTimeout(() => { if (seq === frameLoadSeq) resizeFrame(); }, 300);
  }

  function setupFrameAutoHeight() {
    const frame = getFrame();
    if (!frame) return;
    // 必须在 init/loadBrief 设置 src 之前注册，否则会漏掉首份简报的 load
    frame.addEventListener('load', onFrameLoad);

    window.addEventListener('resize', () => {
      if (typeof requestAnimationFrame !== 'function') { resizeFrame(); return; }
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        resizeFrame();
      });
    });
  }

  async function init() {
    try {
      const resp = await fetch('./briefs/index.json?_=' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) throw new Error('index.json 缺失');
      briefIndex = await resp.json();
    } catch (e) {
      showEmpty('暂未生成任何简报');
      return;
    }

    const dates = Object.keys(briefIndex).sort().reverse();
    if (!dates.length) {
      showEmpty('暂无简报');
      return;
    }

    const sel = document.getElementById('date-pick');
    sel.innerHTML = dates.map(d => `<option value="${d}">${d}</option>`).join('');

    const latest = dates[0];
    currentPeriod = pickLatestPeriod(briefIndex[latest]) || 'morning';
    updatePeriodButtons();

    sel.addEventListener('change', loadBrief);
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPeriod = btn.dataset.period;
        updatePeriodButtons();
        loadBrief();
      });
    });

    loadBrief();
  }

  function pickLatestPeriod(entry) {
    if (!entry) return null;
    for (const p of PERIOD_PRIORITY) {
      if (entry[p]) return p;
    }
    return null;
  }

  function updatePeriodButtons() {
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.period === currentPeriod);
    });
  }

  function loadBrief() {
    const date = document.getElementById('date-pick').value;
    const entry = briefIndex[date];
    if (!entry || !entry[currentPeriod]) {
      const label = PERIOD_LABELS[currentPeriod] || currentPeriod;
      showEmpty(`${date} ${label} 暂无简报`);
      return;
    }
    hideEmpty();
    const path = `./briefs/${date}-${currentPeriod}.html`;
    document.getElementById('brief-frame').src = path;
    const label = PERIOD_LABELS[currentPeriod] || currentPeriod;
    document.getElementById('title-date').textContent =
      `${date} ${label} AI 简报`;
  }

  function showEmpty(msg) {
    document.getElementById('brief-wrap').hidden = true;
    const e = document.getElementById('empty-state');
    e.hidden = false;
    if (msg) e.querySelector('p').textContent = msg;
  }
  function hideEmpty() {
    document.getElementById('brief-wrap').hidden = false;
    document.getElementById('empty-state').hidden = true;
  }

  setupFrameAutoHeight();
  init();
})();
