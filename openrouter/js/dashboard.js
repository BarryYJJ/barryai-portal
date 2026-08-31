// 看板渲染逻辑：拉取 dashboard.json（仅在 gate.js 派发 barry:unlocked 之后）
// 并根据 时间窗口/指标/地域/厂商/搜索 状态渲染 KPI、趋势图、份额图、异动、排行、归档。
(function () {
  const METRIC_LABEL = { p: 'Prompt Token', c: 'Completion Token', r: '请求数' };
  const REGION_LABEL = { all: '全部', cn: '中国', us: '美国', other: '其他' };
  const WINDOW_DAYS = { '7d': 7, '30d': 30, all: Infinity };

  const state = { window: '30d', metric: 'p', region: 'all', provider: 'all', date: null, search: '' };
  let DATA = null;
  let loaded = false;

  function $(id) { return document.getElementById(id); }

  function fmtCount(v) {
    if (v == null) return '—';
    if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(1) + 'T';
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }
  function fmtPct(x, digits) {
    if (x == null || !isFinite(x)) return '—';
    return (x >= 0 ? '+' : '') + (x * 100).toFixed(digits == null ? 1 : digits) + '%';
  }

  // ---------- 数据访问 ----------
  function dayOf(date) { return DATA.daily[date]; }

  function modelsFiltered(region, providerId, search) {
    const q = (search || '').trim().toLowerCase();
    return DATA.models.filter((m) => {
      if (region !== 'all' && m.region !== region) return false;
      if (providerId !== 'all' && m.provider !== providerId) return false;
      if (q && !(m.slug.toLowerCase().includes(q) || m.provider_name.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function metricValue(date, modelId, metricKey) {
    const day = dayOf(date);
    if (!day) return 0;
    const v = day.models[String(modelId)];
    return v ? v[metricKey] : 0;
  }

  // region / provider / search 始终按交集生效，保证 KPI、趋势图与模型排行
  // 在同一组筛选条件下互相一致。未筛选时走预计算的 totals/region_totals
  // 快速路径（数值上与逐模型求和完全等价）。
  function seriesFor(dates, metricKey, region, providerId, search) {
    const q = (search || '').trim();
    if (region === 'all' && providerId === 'all' && !q) {
      return dates.map((d) => {
        const day = dayOf(d);
        return day ? day.totals[metricKey] : 0;
      });
    }
    if (providerId === 'all' && !q) {
      return dates.map((d) => {
        const day = dayOf(d);
        return day ? day.region_totals[region][metricKey] : 0;
      });
    }
    const ids = modelsFiltered(region, providerId, search).map((m) => m.id);
    return dates.map((d) => ids.reduce((sum, id) => sum + metricValue(d, id, metricKey), 0));
  }

  function windowDates(endDate) {
    const idx = DATA.logical_dates.indexOf(endDate);
    const candidates = DATA.logical_dates.slice(0, idx + 1);
    const days = WINDOW_DAYS[state.window];
    if (!isFinite(days)) return candidates;

    // 7D / 30D 表示日历窗口，不是“最近 N 个数据点”。抓取有缺口时，
    // 仍严格限制在结束日往前 6 / 29 个自然日内，避免标签与实际跨度不符。
    const endMs = Date.parse(endDate + 'T00:00:00Z');
    const startMs = endMs - (days - 1) * 24 * 60 * 60 * 1000;
    return candidates.filter((d) => Date.parse(d + 'T00:00:00Z') >= startMs);
  }

  // ---------- 渲染：KPI ----------
  function renderKpis() {
    const date = state.date;
    const day = dayOf(date);
    const metricKey = state.metric;
    const total = seriesFor([date], metricKey, state.region, state.provider, state.search)[0];

    $('kpi-total-label').textContent = `滚动总量 · ${METRIC_LABEL[metricKey]}`;
    $('kpi-total').textContent = fmtCount(total);
    $('kpi-total-sub').textContent = `数据日 ${date}（快照本身即为滚动窗口口径）`;

    const cmp = DATA.comparisons[date];
    const changeEl = $('kpi-change');
    const changeSubEl = $('kpi-change-sub');
    if (cmp && cmp.compare_date) {
      const base = seriesFor([cmp.compare_date], metricKey, state.region, state.provider, state.search)[0];
      if (base > 0) {
        const pct = total / base - 1;
        changeEl.textContent = fmtPct(pct);
        changeEl.className = 'kpi-value ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : '');
        changeSubEl.textContent = `对比 ${cmp.compare_date}（约 ${cmp.interval_days} 天前）`;
      } else {
        changeEl.textContent = '—';
        changeEl.className = 'kpi-value';
        changeSubEl.textContent = '比较日无有效基数';
      }
    } else {
      changeEl.textContent = '—';
      changeEl.className = 'kpi-value';
      changeSubEl.textContent = '暂无满足"至少约7天前"的比较日';
    }

    const cn = day.region_totals.cn[metricKey];
    const usClosed = day.us_closed_totals[metricKey];
    const grand = day.totals[metricKey];
    $('kpi-cn-share').textContent = grand ? ((cn / grand) * 100).toFixed(1) + '%' : '—';
    $('kpi-usclosed-share').textContent = grand ? ((usClosed / grand) * 100).toFixed(1) + '%' : '—';
  }

  // ---------- 渲染：趋势图（内联 SVG，无第三方依赖） ----------
  function renderChart() {
    const dates = windowDates(state.date);
    const values = seriesFor(dates, state.metric, state.region, state.provider, state.search);
    const wrap = $('trend-chart');
    wrap.innerHTML = '';

    const scopeParts = [];
    scopeParts.push(METRIC_LABEL[state.metric]);
    scopeParts.push(REGION_LABEL[state.region] === '全部' ? null : '地域:' + REGION_LABEL[state.region]);
    if (state.provider !== 'all') {
      const p = DATA.providers.find((x) => x.id === state.provider);
      scopeParts.push('厂商:' + (p ? p.name : state.provider));
    }
    if (state.search.trim()) {
      scopeParts.push('搜索:' + state.search.trim());
    }
    $('chart-scope-note').textContent = `${dates[0] || '—'} ~ ${state.date}（${dates.length} 个数据点） · ` +
      scopeParts.filter(Boolean).join(' · ');

    if (dates.length < 2 || values.every((v) => v === 0)) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = '当前筛选下数据点不足，无法绘制趋势。';
      wrap.appendChild(note);
      return;
    }

    const W = 960, H = 260, PAD_L = 56, PAD_R = 16, PAD_T = 16, PAD_B = 28;
    const maxV = Math.max(...values, 1);
    const minV = 0;
    const xStep = (W - PAD_L - PAD_R) / (dates.length - 1);
    const yScale = (v) => PAD_T + (1 - (v - minV) / (maxV - minV || 1)) * (H - PAD_T - PAD_B);
    const xScale = (i) => PAD_L + i * xStep;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '用量趋势图');

    // 网格线 + y 轴刻度
    const gridCount = 4;
    for (let i = 0; i <= gridCount; i++) {
      const v = (maxV / gridCount) * i;
      const y = yScale(v);
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', PAD_L); line.setAttribute('x2', W - PAD_R);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('stroke', '#e7e1d3'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);

      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', PAD_L - 8); label.setAttribute('y', y + 4);
      label.setAttribute('text-anchor', 'end'); label.setAttribute('font-size', '10');
      label.setAttribute('fill', '#8493a3');
      label.textContent = fmtCount(v);
      svg.appendChild(label);
    }

    // x 轴：首/中/末 日期标签
    [0, Math.floor((dates.length - 1) / 2), dates.length - 1].forEach((i) => {
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', xScale(i));
      label.setAttribute('y', H - 8);
      label.setAttribute('text-anchor', i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle');
      label.setAttribute('font-size', '10');
      label.setAttribute('fill', '#8493a3');
      label.textContent = dates[i];
      svg.appendChild(label);
    });

    // 面积 + 折线
    const points = values.map((v, i) => [xScale(i), yScale(v)]);
    const areaPath = ['M', points[0][0], H - PAD_B, 'L', points.map((p) => p.join(',')).join(' L '), 'L', points[points.length - 1][0], H - PAD_B, 'Z'].join(' ');
    const area = document.createElementNS(svgNS, 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'rgba(224,49,49,0.08)');
    svg.appendChild(area);

    const linePath = 'M ' + points.map((p) => p.join(',')).join(' L ');
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', linePath);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#c92a2a');
    line.setAttribute('stroke-width', '2.5');
    svg.appendChild(line);

    const tooltip = $('chart-tooltip');
    function showTipAt(i) {
      const [x, y] = points[i];
      tooltip.hidden = false;
      tooltip.textContent = `${dates[i]} · ${fmtCount(values[i])}`;
      tooltip.style.left = (x / W) * 100 + '%';
      tooltip.style.top = (y / H) * 100 + '%';
    }
    function hideTip() { tooltip.hidden = true; }

    // 逐点圆点 + 键盘可 Tab 聚焦的命中圆（各自不必满足 44px，
    // 因为整图层的指针/触摸命中区域已覆盖鼠标与触屏交互）。
    points.forEach(([x, y], i) => {
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 3);
      dot.setAttribute('fill', '#c92a2a');
      svg.appendChild(dot);

      const hit = document.createElementNS(svgNS, 'circle');
      hit.setAttribute('cx', x); hit.setAttribute('cy', y); hit.setAttribute('r', 10);
      hit.setAttribute('fill', 'transparent');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', `${dates[i]}：${fmtCount(values[i])}`);
      hit.addEventListener('focus', () => showTipAt(i));
      hit.addEventListener('blur', hideTip);
      svg.appendChild(hit);
    });

    // 整图指针/触摸/点击就近取点命中层：覆盖整个绘图区域（远大于 44px），
    // 鼠标移动/触摸滑动/点击都会取最近的数据点显示提示。
    const overlay = document.createElementNS(svgNS, 'rect');
    overlay.setAttribute('x', PAD_L);
    overlay.setAttribute('y', 0);
    overlay.setAttribute('width', Math.max(W - PAD_L - PAD_R, 0));
    overlay.setAttribute('height', H);
    overlay.setAttribute('fill', 'transparent');
    overlay.setAttribute('pointer-events', 'all');
    overlay.style.cursor = 'pointer';

    function nearestIndexFromClientX(clientX) {
      const rect = svg.getBoundingClientRect();
      const relX = rect.width ? ((clientX - rect.left) / rect.width) * W : 0;
      let best = 0, bestDist = Infinity;
      points.forEach(([x], i) => {
        const dist = Math.abs(x - relX);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      return best;
    }

    overlay.addEventListener('pointermove', (e) => showTipAt(nearestIndexFromClientX(e.clientX)));
    overlay.addEventListener('pointerdown', (e) => showTipAt(nearestIndexFromClientX(e.clientX)));
    // 触屏没有"悬停"语义：抬指会立刻触发 pointerleave，若也据此隐藏提示，
    // 点击/轻触就等于白点——只对鼠标/触控笔这类真正可悬停的指针隐藏。
    overlay.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      hideTip();
    });
    overlay.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (t) showTipAt(nearestIndexFromClientX(t.clientX));
    }, { passive: true });
    overlay.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      if (t) showTipAt(nearestIndexFromClientX(t.clientX));
    }, { passive: true });
    svg.appendChild(overlay);

    wrap.appendChild(svg);
  }

  // ---------- 渲染：地域 / 厂商份额 ----------
  function renderShare() {
    const day = dayOf(state.date);
    const metricKey = state.metric;
    const grand = day.totals[metricKey] || 1;

    const barEl = $('region-share-bar');
    barEl.innerHTML = '';
    const legendEl = $('region-share-legend');
    legendEl.innerHTML = '';
    ['cn', 'us', 'other'].forEach((region) => {
      const v = day.region_totals[region][metricKey];
      const pct = (v / grand) * 100;
      const seg = document.createElement('span');
      seg.className = 'seg ' + region;
      seg.style.width = pct.toFixed(1) + '%';
      seg.textContent = pct >= 8 ? `${REGION_LABEL[region]} ${pct.toFixed(1)}%` : '';
      barEl.appendChild(seg);

      const chip = document.createElement('span');
      chip.className = 'chip ' + region;
      chip.textContent = `${REGION_LABEL[region]} ${pct.toFixed(1)}%`;
      legendEl.appendChild(chip);
    });

    const listEl = $('provider-share-list');
    listEl.innerHTML = '';
    const rows = Object.entries(day.provider_totals)
      .map(([id, v]) => ({ id, v: v[metricKey], name: providerName(id) }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 8);
    const maxV = rows.length ? rows[0].v : 1;
    rows.forEach((row) => {
      const pct = (row.v / grand) * 100;
      const el = document.createElement('div');
      el.className = 'provider-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = row.name;
      const track = document.createElement('span');
      track.className = 'track';
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.width = ((row.v / maxV) * 100).toFixed(1) + '%';
      track.appendChild(fill);
      const pctEl = document.createElement('span');
      pctEl.className = 'pct';
      pctEl.textContent = pct.toFixed(1) + '%';
      el.append(nameEl, track, pctEl);
      listEl.appendChild(el);
    });
  }

  function providerName(id) {
    const p = DATA.providers.find((x) => x.id === id);
    return p ? p.name : id;
  }

  // ---------- 排行表 + 异动（同一份筛选后的行） ----------
  function buildRows() {
    const models = modelsFiltered(state.region, state.provider, state.search);
    const date = state.date;
    const metricKey = state.metric;
    const cmp = DATA.comparisons[date];
    const grand = dayOf(date).totals[metricKey] || 1;

    return models
      .map((m) => {
        const current = metricValue(date, m.id, metricKey);
        const compare = cmp && cmp.compare_date ? metricValue(cmp.compare_date, m.id, metricKey) : null;
        const change = compare ? current / compare - 1 : null;
        return { model: m, current, compare, change, share: current / grand };
      })
      .filter((row) => row.current > 0)
      .sort((a, b) => b.current - a.current);
  }

  function renderTable(rows) {
    const body = $('model-table-body');
    body.innerHTML = '';
    $('model-table-count').textContent = rows.length;

    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');

      const rankTd = document.createElement('td');
      rankTd.className = 'rank';
      rankTd.textContent = String(i + 1);

      const nameTd = document.createElement('td');
      const flag = document.createElement('span');
      flag.className = 'region-flag ' + row.model.region;
      nameTd.appendChild(flag);
      nameTd.appendChild(document.createTextNode(row.model.short_name));

      const providerTd = document.createElement('td');
      providerTd.textContent = row.model.provider_name;

      const valueTd = document.createElement('td');
      valueTd.className = 'num';
      valueTd.textContent = fmtCount(row.current);

      const shareTd = document.createElement('td');
      shareTd.className = 'num';
      shareTd.textContent = (row.share * 100).toFixed(2) + '%';

      const changeTd = document.createElement('td');
      changeTd.className = 'num chg ' + (row.change > 0 ? 'up' : row.change < 0 ? 'down' : '');
      changeTd.textContent = row.change == null ? '—' : fmtPct(row.change);

      tr.append(rankTd, nameTd, providerTd, valueTd, shareTd, changeTd);
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  function renderMovers(rows) {
    const grand = dayOf(state.date).totals[state.metric] || 1;
    const threshold = grand * 0.0005; // 过滤掉噪声：至少占当日全平台约 0.05%
    const withChange = rows.filter((r) => r.change != null && r.current >= threshold);

    const gainers = withChange.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, 3);
    const decliners = withChange.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, 3);

    renderMoverList('movers-gainers', gainers, 'up');
    renderMoverList('movers-decliners', decliners, 'down');
  }

  function renderMoverList(elId, list, dir) {
    const el = $(elId);
    el.innerHTML = '';
    if (!list.length) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = '当前筛选下无满足门槛的异动';
      el.appendChild(note);
      return;
    }
    list.forEach((row) => {
      const card = document.createElement('div');
      card.className = 'mover-card';
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = row.model.short_name;
      const by = document.createElement('div');
      by.className = 'by';
      by.textContent = `${row.model.provider_name} · ${fmtCount(row.current)}`;
      left.append(name, by);
      const chg = document.createElement('div');
      chg.className = 'chg ' + dir;
      chg.textContent = fmtPct(row.change);
      card.append(left, chg);
      el.appendChild(card);
    });
  }

  // ---------- 归档 ----------
  function renderArchive() {
    const listEl = $('report-archive-list');
    listEl.innerHTML = '';
    const reports = (DATA.reports || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    reports.forEach((r) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = './reports/' + encodeURIComponent(r.file);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = r.date + ' 周报';
      li.appendChild(a);
      listEl.appendChild(li);
    });
  }

  // ---------- 控件初始化 ----------
  function initControls() {
    const dateSelect = $('date-select');
    dateSelect.innerHTML = '';
    DATA.logical_dates.slice().reverse().forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d; opt.textContent = d;
      dateSelect.appendChild(opt);
    });
    dateSelect.value = state.date;
    dateSelect.addEventListener('change', () => { state.date = dateSelect.value; renderAll(); });

    const providerSelect = $('provider-select');
    const providersByVolume = DATA.providers.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    providersByVolume.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      providerSelect.appendChild(opt);
    });
    providerSelect.addEventListener('change', () => { state.provider = providerSelect.value; renderAll(); });

    bindToggleGroup('ctrl-window', 'window');
    bindToggleGroup('ctrl-metric', 'metric');
    bindToggleGroup('ctrl-region', 'region');

    let searchTimer = null;
    $('model-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const value = e.target.value;
      searchTimer = setTimeout(() => { state.search = value; renderAll(); }, 120);
    });
  }

  function bindToggleGroup(groupId, stateKey) {
    const group = $(groupId);
    group.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        state[stateKey] = btn.dataset[stateKey];
        renderAll();
      });
    });
  }

  function renderTableAndMovers() {
    const rows = buildRows();
    renderTable(rows);
    renderMovers(rows);
  }

  function renderAll() {
    if (!loaded) return;
    renderKpis();
    renderChart();
    renderShare();
    renderTableAndMovers();
  }

  function renderFooter() {
    $('footer-generated').textContent =
      `最新数据日 ${DATA.latest_date} · 基于抓取快照 ${DATA.source_snapshot}（${DATA.snapshot_captured_on} 抓取）生成`;
    $('header-meta').textContent = `数据来源 OpenRouter 全球路由真实用量 · 最新数据日 ${DATA.latest_date}`;
  }

  async function loadAndRender() {
    if (loaded) { renderAll(); return; }
    try {
      const resp = await fetch('./data/dashboard.json?_=' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      DATA = await resp.json();
    } catch (e) {
      const el = document.getElementById('fatal-error');
      el.hidden = false;
      el.textContent = '看板数据加载失败，请刷新重试：' + (e.message || e);
      return;
    }
    state.date = DATA.latest_date;
    loaded = true;
    initControls();
    renderFooter();
    renderArchive();
    renderAll();
  }

  window.addEventListener('barry:unlocked', loadAndRender);
})();
