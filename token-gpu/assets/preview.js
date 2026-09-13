// 公开预览：只读同目录 data/dashboard.json，把 Neo-cloud B200、Ornn H100 价格与 Token 综合近 30 日走势
// 填进 #access 分区的预览位。完整的日度序列、区间切换与来源状态仍由 app.js 在解锁后渲染。
// 任何拉取 / 结构错误都只换成一句降级文案，绝不影响下方表单与闸门。
(function () {
  'use strict';
  var DATA_URL = 'data/dashboard.json';
  var TREND_DAYS = 30;

  var $ = function (id) { return document.getElementById(id); };
  var kpiRow = $('access-preview');
  if (!kpiRow) return;

  // 上方保留 Neo-cloud B200 与 Ornn H100 价格，Token 综合支出指数交给下方折线图表达。
  var KPIS = [
    { block: 'gpu', key: 'neo_b200', label: 'B200租赁价格丨Neo-cloud B200', unit: 'USD / GPU-hour', decimals: 2 },
    { block: 'ornn', key: 'h100_sxm', label: 'H100租赁价格丨Ornn H100', unit: 'USD / GPU-hour', decimals: 2 },
  ];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function fmt(v, decimals) {
    return typeof v === 'number' && isFinite(v) ? v.toFixed(decimals) : '暂无';
  }
  function fmtPct(x) {
    return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  }
  function findSeries(doc, block, key) {
    var list = doc && doc[block] && doc[block].series;
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === key) return list[i];
    return null;
  }
  function cleanObs(series) {
    var obs = series && Array.isArray(series.observations) ? series.observations : [];
    return obs.filter(function (o) { return o && typeof o.date === 'string' && typeof o.value === 'number' && isFinite(o.value); });
  }
  function addDaysISO(iso, delta) {
    var p = iso.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  function renderKpis(doc) {
    var tiles = [];
    KPIS.forEach(function (k) {
      var s = findSeries(doc, k.block, k.key);
      if (!s) return;
      var obs = cleanObs(s);
      var latest = obs.length ? obs[obs.length - 1] : null;
      var stale = doc[k.block].freshness && doc[k.block].freshness.stale;
      var dateText = latest ? latest.date + (stale ? '（滞后）' : '') : '暂无观测';
      var deltaText = '30 日 暂无';
      // 30 日前的同序列读数存在时给出变化幅度；不存在就明确标为暂无。
      if (latest) {
        var cutoff = addDaysISO(latest.date, -TREND_DAYS);
        var base = null;
        for (var i = 0; i < obs.length; i++) if (obs[i].date <= cutoff) base = obs[i];
        if (base && base.value !== 0) deltaText = '30 日 ' + fmtPct((latest.value - base.value) / base.value);
      }
      var tile = el('div', 'kpi-tile');
      var valueLine = el('p', 'kpi-tile__value-line');
      valueLine.appendChild(el('span', 'kpi-tile__value', fmt(latest && latest.value, k.decimals)));
      valueLine.appendChild(document.createTextNode('丨'));
      valueLine.appendChild(el('span', 'kpi-tile__value-unit', k.unit));
      tile.appendChild(el('p', 'kpi-tile__label', k.label));
      tile.appendChild(valueLine);
      tile.appendChild(el('p', 'kpi-tile__detail', deltaText + '丨' + dateText));
      tiles.push(tile);
    });
    if (!tiles.length) throw new Error('no series');
    kpiRow.textContent = '';
    tiles.forEach(function (t) { kpiRow.appendChild(t); });
  }

  function renderTrend(doc) {
    var fig = $('access-trend'), svg = $('access-trend-svg'), cap = $('access-trend-caption');
    if (!fig || !svg || !cap) return;
    var obs = cleanObs(findSeries(doc, 'token', 'expenditure'));
    if (obs.length < 2) return;
    var cutoff = addDaysISO(obs[obs.length - 1].date, -(TREND_DAYS - 1));
    var pts = obs.filter(function (o) { return o.date >= cutoff; });
    if (pts.length < 2) return;

    var W = 320, H = 96, PAD = 6;
    var min = Infinity, max = -Infinity;
    pts.forEach(function (p) { if (p.value < min) min = p.value; if (p.value > max) max = p.value; });
    var span = max - min || 1;
    var t0 = Date.parse(pts[0].date), t1 = Date.parse(pts[pts.length - 1].date);
    var coords = pts.map(function (p) {
      var x = PAD + (W - 2 * PAD) * (Date.parse(p.date) - t0) / (t1 - t0);
      var y = H - PAD - (H - 2 * PAD) * (p.value - min) / span;
      return [x.toFixed(1), y.toFixed(1)];
    });
    var flat = coords.map(function (c) { return c.join(','); }).join(' ');
    var ns = 'http://www.w3.org/2000/svg';
    var area = document.createElementNS(ns, 'polygon');
    area.setAttribute('class', 'access__trend-area');
    area.setAttribute('points', coords[0][0] + ',' + (H - PAD) + ' ' + flat + ' ' + coords[coords.length - 1][0] + ',' + (H - PAD));
    var line = document.createElementNS(ns, 'polyline');
    line.setAttribute('class', 'access__trend-line');
    line.setAttribute('points', flat);
    var dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('class', 'access__trend-end');
    dot.setAttribute('cx', coords[coords.length - 1][0]);
    dot.setAttribute('cy', coords[coords.length - 1][1]);
    dot.setAttribute('r', '3');
    svg.appendChild(area); svg.appendChild(line); svg.appendChild(dot);

    var first = pts[0], last = pts[pts.length - 1];
    var change = first.value !== 0 ? fmtPct((last.value - first.value) / first.value) : '';
    var title = svg.querySelector('title');
    if (title) title.textContent = 'Token 综合支出指数 ' + first.date + ' 至 ' + last.date + ' 走势';
    cap.textContent = 'Token 综合支出指数 ' + first.date + ' ~ ' + last.date + '，' + pts.length + ' 个观测日，区间 ' +
      fmt(min, 4) + ' ~ ' + fmt(max, 4) + (change ? '，期间 ' + change : '') + '。解锁后可查看三条序列的完整历史。';
    fig.hidden = false;
  }

  function degrade(err) {
    kpiRow.textContent = '';
    kpiRow.appendChild(el('p', 'error-copy', '最新读数暂时无法加载，留下联系方式后仍可解锁完整看板。（' +
      (err && err.message ? err.message : '未知错误') + '）'));
  }

  if (!window.fetch) { degrade(new Error('浏览器不支持 fetch')); return; }
  fetch(DATA_URL, { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (doc) {
      renderKpis(doc);
      try { renderTrend(doc); } catch (e) { /* 走势是加分项，画不出来不影响读数 */ }
    })
    .catch(degrade);
})();
