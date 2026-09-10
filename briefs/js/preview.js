// 闸门页公开预览：从同源公开文件读最新一期简报的元数据，填进 #gate-preview。
// 任何一步失败都只换成一句降级文案，表单永远照常可用。
(function () {
  const root = document.getElementById('gate-preview');
  if (!root) return;

  const PERIOD_LABELS = { morning: '早间', noon: '午间', evening: '晚间', night: '深夜' };
  const PERIOD_PRIORITY = ['evening', 'noon', 'morning', 'night'];
  const MAX_HEADLINES = 3;
  const MAX_KEYWORDS = 4;

  const statusEl = root.querySelector('[data-preview-status]');
  const metaEl = root.querySelector('[data-preview-meta]');
  const listEl = root.querySelector('[data-preview-headlines]');
  const kwEl = root.querySelector('[data-preview-keywords]');

  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

  function pickLatest(index) {
    const dates = Object.keys(index).sort().reverse();
    for (const d of dates) {
      for (const p of PERIOD_PRIORITY) {
        if (index[d] && index[d][p]) return { date: d, period: p, dates: dates.length };
      }
    }
    return null;
  }

  function countBriefs(index) {
    let n = 0;
    for (const d of Object.keys(index)) {
      for (const p of Object.keys(index[d] || {})) if (index[d][p]) n++;
    }
    return n;
  }

  function addRow(dl, label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderMeta(latest, total, stats) {
    metaEl.textContent = '';
    addRow(metaEl, '最新一期', latest.date + ' ' + (PERIOD_LABELS[latest.period] || latest.period));
    if (stats.hits) addRow(metaEl, '本期 AI 命中', stats.hits);
    if (stats.window) addRow(metaEl, '时间窗', stats.window);
    addRow(metaEl, '归档', latest.dates + ' 天 / ' + total + ' 期');
  }

  function renderHeadlines(items) {
    listEl.textContent = '';
    for (const text of items.slice(0, MAX_HEADLINES)) {
      const li = document.createElement('li');
      li.textContent = text;
      listEl.appendChild(li);
    }
    listEl.hidden = listEl.children.length === 0;
  }

  function renderKeywords(items) {
    kwEl.textContent = '';
    for (const k of items.slice(0, MAX_KEYWORDS)) {
      const span = document.createElement('span');
      span.className = 'gate-kw';
      span.textContent = k.name + ' ' + k.count;
      kwEl.appendChild(span);
    }
    kwEl.hidden = kwEl.children.length === 0;
  }

  // 从简报 HTML 里提取要点标题、热词与本期统计（纯读取，不执行其中脚本）
  function parseBrief(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headlines = Array.from(doc.querySelectorAll('.tldr a.tldr-jump, .tldr li'))
      .map(el => (el.textContent || '').trim()).filter(Boolean);
    const keywords = Array.from(doc.querySelectorAll('.hot-kw-row')).map(row => ({
      name: (row.querySelector('.kw-name') || {}).textContent || '',
      count: (row.querySelector('.kw-count') || {}).textContent || '',
    })).filter(k => k.name);
    const stats = {};
    for (const row of doc.querySelectorAll('.stat-row')) {
      const label = ((row.querySelector('.label') || {}).textContent || '').trim();
      const value = ((row.querySelector('.value') || {}).textContent || '').trim();
      if (label === 'AI 命中') stats.hits = value;
      if (label === '时间窗') stats.window = value;
    }
    return { headlines: Array.from(new Set(headlines)), keywords, stats };
  }

  async function load() {
    setStatus('正在读取最新一期…');
    let index;
    try {
      const resp = await fetch('/briefs/briefs/index.json?_=' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) throw new Error('index.json ' + resp.status);
      index = await resp.json();
    } catch (e) {
      setStatus('预览暂时加载不出来，填表后仍可直接阅读。');
      return;
    }
    const latest = pickLatest(index || {});
    if (!latest) {
      setStatus('暂未生成简报。');
      return;
    }
    const total = countBriefs(index);
    renderMeta(latest, total, {});
    setStatus('');

    try {
      const resp = await fetch('/briefs/briefs/' + latest.date + '-' + latest.period + '.html', { cache: 'no-store' });
      if (!resp.ok) throw new Error('brief ' + resp.status);
      const parsed = parseBrief(await resp.text());
      renderMeta(latest, total, parsed.stats);
      renderHeadlines(parsed.headlines);
      renderKeywords(parsed.keywords);
    } catch (e) {
      // 元数据已经显示；要点拿不到就只显示元数据
    }
  }

  load();
})();
