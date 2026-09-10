// 公开预览：读取 ./data/preview.json（build_dashboard.py 与主制品同时生成的小文件），
// 用真实汇总数据填首屏预览卡。任何失败只换成一句降级文案，绝不影响下方表单与看板。
(function () {
  'use strict';
  var card = document.getElementById('public-preview');
  if (!card || !window.fetch) return;

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('preview-status');

  function fmtCount(v) {
    if (v == null || !isFinite(v)) return '—';
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
  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }
  function setDelta(el, change, label) {
    if (typeof change !== 'number' || !isFinite(change)) { el.textContent = ''; return; }
    el.textContent = label + ' ' + fmtPct(change);
    el.classList.toggle('up', change > 0);
    el.classList.toggle('down', change < 0);
  }

  function renderTrend(trend) {
    var svg = $('preview-trend');
    var points = (trend || []).filter(function (p) { return p && typeof p.tokens === 'number'; });
    if (points.length < 2) { svg.hidden = true; return; }
    var W = 320, H = 96, PAD = 6;
    var min = Infinity, max = -Infinity;
    points.forEach(function (p) { if (p.tokens < min) min = p.tokens; if (p.tokens > max) max = p.tokens; });
    var span = max - min || 1;
    var coords = points.map(function (p, i) {
      var x = PAD + (W - 2 * PAD) * i / (points.length - 1);
      var y = H - PAD - (H - 2 * PAD) * (p.tokens - min) / span;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var ns = 'http://www.w3.org/2000/svg';
    var area = document.createElementNS(ns, 'polygon');
    area.setAttribute('points', PAD + ',' + (H - PAD) + ' ' + coords.join(' ') + ' ' + (W - PAD) + ',' + (H - PAD));
    area.setAttribute('fill', 'rgba(27, 52, 232, 0.08)');
    var line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', coords.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#1b34e8');
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(area);
    svg.appendChild(line);
    var title = svg.querySelector('title');
    if (title) title.textContent = '日 Token 用量走势：' + points[0].date + ' 至 ' + points[points.length - 1].date;
    svg.hidden = false;
  }

  function renderBar(p) {
    var cn = p.cn_share, us = p.us_share;
    if (typeof cn !== 'number' || typeof us !== 'number') return;
    var other = Math.max(0, 1 - cn - us);
    $('preview-seg-cn').style.width = (cn * 100).toFixed(1) + '%';
    $('preview-seg-us').style.width = (us * 100).toFixed(1) + '%';
    $('preview-seg-other').style.width = (other * 100).toFixed(1) + '%';
    $('preview-bar').hidden = false;
    $('preview-bar').setAttribute('title', '按 Token 的地域结构：中国 ' + (cn * 100).toFixed(1) + '% / 美国 ' + (us * 100).toFixed(1) + '% / 其他 ' + (other * 100).toFixed(1) + '%');
  }

  function render(p) {
    if (!p || !p.latest_date || !p.totals) throw new Error('preview shape');
    $('preview-date').textContent = p.latest_date;
    $('preview-tokens').textContent = fmtCount(p.totals.tokens);
    $('preview-requests').textContent = fmtCount(p.totals.requests);
    var c = p.change_7d || {};
    var label = c.interval_days ? c.interval_days + ' 日' : '较上期';
    setDelta($('preview-tokens-delta'), c.tokens, label);
    setDelta($('preview-requests-delta'), c.requests, label);
    if (typeof p.cn_share === 'number') {
      $('preview-cn-share').textContent = (p.cn_share * 100).toFixed(1) + '%';
      $('preview-cn-note').textContent = '按 Token 计';
    }
    $('preview-kpis').hidden = false;
    renderTrend(p.trend);
    renderBar(p);
    var caption = [];
    if (p.model_count) caption.push(p.model_count + ' 个模型');
    if (p.provider_count) caption.push(p.provider_count + ' 家厂商');
    if (p.logical_date_count) caption.push(p.logical_date_count + ' 个数据日');
    if (p.snapshot_captured_on) caption.push('快照 ' + p.snapshot_captured_on);
    $('preview-caption').textContent = (caption.length ? caption.join(' · ') + '。' : '') + '解锁后查看厂商份额、模型周榜、异动追踪与全部历史数据。';
    setStatus('');
  }

  fetch('./data/preview.json?_=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('preview.json ' + r.status); return r.json(); })
    .then(render)
    .catch(function () {
      $('preview-date').textContent = '';
      setStatus('预览数据暂时读取不到，填表后看板仍会正常加载。');
    });
})();
