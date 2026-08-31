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

  init();
})();
