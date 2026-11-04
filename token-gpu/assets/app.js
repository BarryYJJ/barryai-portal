(function () {
  'use strict';

  var DATA_URL = 'data/dashboard.json';
  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function fmt(value, decimals) {
    return typeof value === 'number' && isFinite(value) ? value.toFixed(decimals) : '—';
  }

  function uniqueSorted(values) {
    var seen = {};
    var out = [];
    values.forEach(function (v) {
      if (!seen[v]) { seen[v] = true; out.push(v); }
    });
    out.sort();
    return out;
  }

  function unionDates(seriesList) {
    var seen = {};
    seriesList.forEach(function (series) {
      series.observations.forEach(function (obs) { seen[obs.date] = true; });
    });
    return Object.keys(seen).sort();
  }

  function valueAt(series, date) {
    for (var i = 0; i < series.observations.length; i++) {
      if (series.observations[i].date === date) return series.observations[i].value;
    }
    return null;
  }

  function addDaysISO(iso, delta) {
    var parts = iso.split('-').map(Number);
    var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  // Calendar-window filter anchored on this series' own latest observation
  // date (not a fixed observation count), so sparse series degrade gracefully
  // instead of pulling in dates far outside the nominal window.
  var RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
  function sliceByRange(observations, range) {
    if (range === 'all' || !observations.length) return observations;
    var days = RANGE_DAYS[range] || 30;
    var latestDate = observations[observations.length - 1].date;
    var cutoff = addDaysISO(latestDate, -(days - 1));
    return observations.filter(function (o) { return o.date >= cutoff; });
  }

  // ── tooltip ────────────────────────────────────────────────────────────
  var tooltipEl = document.getElementById('tooltip');
  function showTooltip(x, y, text) {
    if (!tooltipEl) return;
    tooltipEl.textContent = text;
    var left = Math.min(x + 14, window.innerWidth - 220);
    tooltipEl.style.left = Math.max(left, 4) + 'px';
    tooltipEl.style.top = Math.max(y - 16, 4) + 'px';
    tooltipEl.hidden = false;
  }
  function hideTooltip() { if (tooltipEl) tooltipEl.hidden = true; }

  // ── SVG line chart (dependency-free, no chart library) ──────────────────
  function renderLineChart(container, seriesList, options) {
    options = options || {};
    var decimals = options.decimals === undefined ? 2 : options.decimals;
    // Small multiples over a tight y-domain need an extra digit on the axis or
    // consecutive ticks collapse to the same label; tooltips keep `decimals`.
    var axisDecimals = options.axisDecimals === undefined ? decimals : options.axisDecimals;
    container.textContent = '';

    var dates = options.domainDates || unionDates(seriesList);
    if (!dates.length || !seriesList.some(function (s) { return s.observations.length; })) {
      container.appendChild(el('p', { class: 'loading-copy', text: '当前筛选下暂无可绘制的数据。' }));
      return;
    }

    var width = options.width || 880, height = options.height || 320;
    var pad = options.pad || { top: 16, right: 20, bottom: 34, left: 58 };
    var innerW = width - pad.left - pad.right;
    var innerH = height - pad.top - pad.bottom;

    var values = [];
    seriesList.forEach(function (s) { s.observations.forEach(function (o) { values.push(o.value); }); });
    var minV = Math.min.apply(null, values);
    var maxV = Math.max.apply(null, values);
    if (minV === maxV) { minV -= 1; maxV += 1; }
    var padV = (maxV - minV) * 0.08;
    minV -= padV; maxV += padV;

    function xAt(i) { return pad.left + (dates.length === 1 ? innerW / 2 : ((Date.parse(dates[i]) - Date.parse(dates[0])) / (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0]))) * innerW); }
    function yAt(v) { return pad.top + innerH - ((v - minV) / (maxV - minV)) * innerH; }

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      width: String(width),
      height: String(height),
      role: 'img',
      'aria-label': options.ariaLabel || '走势图',
    });

    var ticks = options.yTicks || 4;
    for (var t = 0; t <= ticks; t++) {
      var v = minV + ((maxV - minV) * t) / ticks;
      var y = yAt(v);
      svg.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: 'chart-grid-line' }));
      var label = svgEl('text', { x: pad.left - 8, y: y + 4, class: 'chart-axis-label', 'text-anchor': 'end' });
      label.textContent = fmt(v, axisDecimals);
      svg.appendChild(label);
    }
    svg.appendChild(svgEl('line', { x1: pad.left, x2: pad.left, y1: pad.top, y2: height - pad.bottom, class: 'chart-axis-line' }));
    svg.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom, class: 'chart-axis-line' }));

    // Narrow (portrait) charts only have room for the two endpoint dates.
    var xTicks = options.xTickCount === 2
      ? (dates.length > 1 ? [0, dates.length - 1] : [0])
      : [0, Math.floor((dates.length - 1) / 2), dates.length - 1];
    xTicks = xTicks.filter(function (value, i, all) { return all.indexOf(value) === i; });
    xTicks.forEach(function (i, idx) {
      var anchor = idx === 0 ? 'start' : (idx === xTicks.length - 1 ? 'end' : 'middle');
      var label = svgEl('text', { x: xAt(i), y: height - pad.bottom + 18, class: 'chart-axis-label', 'text-anchor': anchor });
      label.textContent = dates[i];
      svg.appendChild(label);
    });

    seriesList.forEach(function (series) {
      var points = [];
      dates.forEach(function (d, i) {
        var v = valueAt(series, d);
        if (v !== null) points.push({ x: xAt(i), y: yAt(v), date: d, value: v });
      });
      if (!points.length) return;
      // Daily OTPI gaps are separate segments, including days absent from
      // every lab. A visual line must not invent unobserved daily prices.
      var pathData = points.map(function (p, i) {
        var gap = options.breakDailyGaps && i > 0 && addDaysISO(points[i - 1].date, 1) !== p.date;
        return (i === 0 || gap ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2);
      }).join(' ');
      svg.appendChild(svgEl('path', { d: pathData, class: 'chart-series-path', style: 'stroke:' + series.color }));
      points.forEach(function (p) {
        var text = series.label + '：' + p.date + ' = ' + fmt(p.value, decimals);
        var circle = svgEl('circle', {
          cx: p.x, cy: p.y, r: 3.4, class: 'chart-point', style: 'fill:' + series.color,
          tabindex: '0', role: 'img', 'aria-label': text,
        });
        var title = svgEl('title', {});
        title.textContent = text;
        circle.appendChild(title);
        function reveal() {
          var rect = svg.getBoundingClientRect();
          var scaleX = rect.width / width, scaleY = rect.height / height;
          showTooltip(rect.left + p.x * scaleX, rect.top + p.y * scaleY, text);
        }
        circle.addEventListener('mouseenter', reveal);
        circle.addEventListener('mouseleave', hideTooltip);
        circle.addEventListener('focus', reveal);
        circle.addEventListener('blur', hideTooltip);
        svg.appendChild(circle);
      });
    });

    container.appendChild(svg);
  }

  // Comparison overview: pure model and markup
  // Separate from the existing small multiples and OTPI. Only these exact
  // public-schema identities may enter the comparison; metadata is not data.
  var COMPARISON_BASE = '2026-09-19';
  var COMPARISON_BASES = { '2026-09-19': '共同可用基期', '2026-05-31': '原图基期' };
  var COMPARISON_START = '2026-01-01';
  var COMPARISON_END = '2026-12-31';
  var COMPARISON_DAY = 86400000;
  var COMPARISON_SERIES = [
    { key: 'expenditure', block: 'token', label: 'LLM Token Expenditure', axis: 'left', color: '#111111' },
    { key: 'neo_h100', block: 'gpu', model: 'H100', label: 'Neo-cloud H100', axis: 'right', color: '#2463c5' },
    { key: 'neo_b200', block: 'gpu', model: 'B200', label: 'Neo-cloud B200', axis: 'right', color: '#d97706' },
    { key: 'neo_b300', block: 'gpu', model: 'B300', label: 'Neo-cloud B300', axis: 'right', color: '#8b5a2b' }
  ];

  function comparisonDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    var ms = Date.parse(date + 'T00:00:00Z');
    return isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
  }

  function comparisonPositive(value) { return typeof value === 'number' && isFinite(value) && value > 0; }

  function buildComparison(doc, baseDate) {
    baseDate = baseDate === undefined ? COMPARISON_BASE : baseDate;
    if (!Object.prototype.hasOwnProperty.call(COMPARISON_BASES, baseDate)) throw new Error('Invalid comparison baseline');
    doc = doc || {};
    var series = COMPARISON_SERIES.map(function (identity) {
      var s = Object.assign({}, identity, { baseDate: baseDate, base: null, latest: null, change: null, points: [], status: 'missing-series' });
      var block = doc[identity.block];
      if (!block || !Array.isArray(block.series)) return s;
      var matches = block.series.filter(function (item) { return item && item.key === s.key; });
      if (matches.length !== 1) { s.status = matches.length ? 'invalid-identity' : 'missing-series'; return s; }
      var source = matches[0];
      if (block.unit !== (s.axis === 'left' ? 'USD/1M tokens' : 'USD/GPU-hour') ||
          (s.axis === 'right' && (source.group !== 'neo' || source.model !== s.model))) {
        s.status = 'invalid-identity'; return s;
      }
      var observations = Array.isArray(source.observations) ? source.observations : [];
      // Group BEFORE filtering values: even identical duplicate base rows are
      // ambiguous. Invalid and duplicate non-base days remain daily gaps.
      var days = Object.create(null);
      observations.forEach(function (o) {
        if (o && comparisonDate(o.date)) (days[o.date] || (days[o.date] = [])).push(o);
      });
      var actual = Object.keys(days).sort().filter(function (date) {
        return date >= COMPARISON_START && date <= COMPARISON_END && days[date].length === 1 && comparisonPositive(days[date][0].value);
      }).map(function (date) { return { date: date, raw: days[date][0].value, value: null }; });
      s.latest = actual.length ? Object.assign({}, actual[actual.length - 1]) : null;
      if (s.axis === 'right') {
        var baseRows = days[baseDate] || [];
        if (!baseRows.length) { s.status = 'missing-base'; return s; }
        if (baseRows.length !== 1) { s.status = 'duplicate-base'; return s; }
        if (!comparisonPositive(baseRows[0].value)) { s.status = 'invalid-base'; return s; }
        s.base = baseRows[0].value;
      }
      s.points = actual.map(function (p) {
        return { date: p.date, raw: p.raw, value: s.axis === 'left' ? p.raw : p.raw / s.base * 100 };
      });
      if (s.points.some(function (p) { return !comparisonPositive(p.value); })) {
        s.points = []; s.status = 'invalid-index'; return s;
      }
      s.latest = s.points.length ? s.points[s.points.length - 1] : null;
      s.status = s.latest ? 'ok' : 'no-data';
      if (s.latest && s.axis === 'right') s.change = s.latest.value - 100;
      return s;
    });
    var end = baseDate; // Keep the exact baseline marker in empty/early windows.
    series.forEach(function (s) { if (s.latest && s.latest.date > end) end = s.latest.date; });
    return { baseDate: baseDate, baseLabel: COMPARISON_BASES[baseDate], start: COMPARISON_START, end: end, series: series };
  }

  function comparisonEscape(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function comparisonPending(s) {
    var reasons = {
      'missing-base': '缺少' + s.baseDate + '基准数据，暂不绘制指数',
      'invalid-base': s.baseDate + '基准数据无效（须为正数），暂不绘制指数',
      'duplicate-base': s.baseDate + '基准日重复，暂不绘制指数',
      'invalid-identity': '序列身份或单位不符，暂不绘制',
      'missing-series': '缺少对应来源序列，暂不绘制',
      'invalid-index': '指数超出有效数值范围，暂不绘制',
      'no-data': '2026年暂无有效观测，暂不绘制'
    };
    return (s.model || 'Token') + '：' + (reasons[s.status] || '');
  }

  function comparisonStatus(model) {
    var dates = model.series.filter(function (s) { return s.latest; }).map(function (s) { return s.latest.date; });
    var mismatch = dates.some(function (date) { return date !== dates[0]; });
    var pending = model.series.filter(function (s) { return s.status !== 'ok'; }).map(comparisonPending);
    return (mismatch ? '最新观测日期不一致，请以各图例实际日期为准。' : '各序列实际观测日期见图例。') +
      '展示区间：' + model.start + ' 至 ' + model.end + '。' + (pending.length ? ' ' + pending.join('；') : '');
  }

  function comparisonLegend(model) {
    return model.series.map(function (s) {
      var available = s.status === 'ok';
      var detail = s.latest ? String(s.latest.raw) + (s.axis === 'left' ? ' USD/1M tokens' : ' USD/GPU-hour') + ' · ' + s.latest.date : '无实际观测';
      var index = available && s.axis === 'right' ? '指数 ' + s.latest.value.toFixed(2) + ' · 较基准 ' + (s.change >= 0 ? '+' : '') + s.change.toFixed(2) + '%' : '';
      var base = available && s.axis === 'right' ? s.baseDate + ' 基准价格 ' + String(s.base) + ' USD/GPU-hour' : '';
      return '<button type="button" class="comparison-toggle" data-comparison-key="' + s.key + '"' +
        (available ? ' aria-pressed="true"' : ' disabled aria-pressed="false"') + ' style="--comparison-color:' + s.color + '">' +
        '<span class="comparison-label"><span class="comparison-swatch" aria-hidden="true"></span>' + comparisonEscape(s.label) + ' · ' + (s.axis === 'left' ? '左轴' : '右轴') + '</span>' +
        '<span>' + comparisonEscape(detail) + '</span>' +
        (index ? '<span>' + comparisonEscape(index) + '</span><span>' + comparisonEscape(base) + '</span>' : '') +
        (!available ? '<span class="comparison-pending">' + comparisonEscape(comparisonPending(s)) + '</span>' : '') + '</button>';
    }).join('');
  }

  function toggleComparison(model, visible, key) {
    var s = model.series.find(function (item) { return item.key === key; });
    if (!s || s.status !== 'ok') return false;
    visible[key] = !visible[key];
    return true;
  }

  function comparisonGeometry(model) {
    var width = 1040, height = 440, left = 78, right = 962, top = 54, bottom = 366;
    function scale(axis) {
      var values = axis === 'right' ? [100] : [];
      model.series.forEach(function (s) { if (s.axis === axis) s.points.forEach(function (p) { values.push(p.value); }); });
      var low = values.length ? Math.min.apply(null, values) : 0;
      var high = values.length ? Math.max.apply(null, values) : 1;
      var pad = (high - low) * 0.1 || Math.abs(high) * 0.1 || 1;
      low = Math.max(0, low - pad); high += pad;
      return { min: low, max: high, y: function (v) { return bottom - (v - low) / (high - low) * (bottom - top); } };
    }
    return {
      width: width, height: height, plotLeft: left, plotRight: right, top: top, bottom: bottom,
      left: scale('left'), right: scale('right'),
      x: function (date) { return left + (Date.parse(date) - Date.parse(model.start)) / (Date.parse(model.end) - Date.parse(model.start)) * (right - left); }
    };
  }

  function comparisonPointText(s, p) {
    return s.label + ' · ' + (s.axis === 'left' ? '左轴' : '右轴') + ' · ' + p.date + ' · ' + String(p.raw) +
      (s.axis === 'left' ? ' USD/1M tokens' : ' USD/GPU-hour · 指数 ' + p.value.toFixed(2) + '（' + s.baseDate + ' = 100）');
  }

  function comparisonMarkup(model, visible) {
    var g = comparisonGeometry(model);
    var selected = model.series.filter(function (s) { return s.status === 'ok' && visible[s.key]; });
    function text(x, y, label, anchor) {
      return '<text x="' + x + '" y="' + y + '" text-anchor="' + (anchor || 'start') + '" class="comparison-axis">' + comparisonEscape(label) + '</text>';
    }
    function line(x1, y1, x2, y2, cls) {
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="' + cls + '"/>';
    }
    var html = '<svg viewBox="0 0 ' + g.width + ' ' + g.height + '" role="group" aria-label="2026 Token 与 GPU 双轴价格对照，两轴均为线性" aria-describedby="comparison-help">' +
      '<title>Silicon Data Token 原始价格与 Neo-cloud GPU 基准指数</title>' +
      text(g.plotLeft, 20, '左轴 · USD / 1M tokens') + text(g.plotRight, 20, '右轴 · GPU 指数（' + model.baseDate + ' = 100）', 'end');
    for (var t = 0; t <= 5; t++) {
      var y = g.bottom - (g.bottom - g.top) * t / 5;
      html += line(g.plotLeft, y, g.plotRight, y, 'comparison-grid');
      ['left', 'right'].forEach(function (axis) {
        var value = g[axis].min + (g[axis].max - g[axis].min) * t / 5;
        html += text(axis === 'left' ? g.plotLeft - 10 : g.plotRight + 10, y + 4, Number(value.toPrecision(4)), axis === 'left' ? 'end' : 'start');
      });
    }
    html += line(g.plotLeft, g.top, g.plotLeft, g.bottom, 'comparison-axis-line') + line(g.plotRight, g.top, g.plotRight, g.bottom, 'comparison-axis-line');
    for (var month = 1; month <= 11; month += 2) {
      var date = '2026-' + String(month).padStart(2, '0') + '-01';
      if (date < model.end && g.x(model.end) - g.x(date) > 84) html += text(g.x(date), g.bottom + 25, date, month === 1 ? 'start' : 'middle');
    }
    html += text(g.x(model.end), g.bottom + 25, model.end, 'end');
    html += line(g.x(model.baseDate), g.top, g.x(model.baseDate), g.bottom, 'comparison-base-date') + text(g.x(model.baseDate), 42, model.baseDate, 'middle');
    html += line(g.plotLeft, g.right.y(100), g.plotRight, g.right.y(100), 'comparison-base-index') + text(g.plotRight - 5, g.right.y(100) - 7, '右轴 100', 'end');
    selected.forEach(function (s) {
      var path = s.points.map(function (p, i) {
        var gap = i === 0 || Date.parse(p.date) - Date.parse(s.points[i - 1].date) !== COMPARISON_DAY;
        return (gap ? 'M' : 'L') + g.x(p.date).toFixed(2) + ',' + g[s.axis].y(p.value).toFixed(2);
      }).join(' ');
      html += '<path data-series="' + s.key + '" d="' + path + '" fill="none" stroke="' + s.color + '" class="comparison-path"/>';
      s.points.forEach(function (p, i) {
        var isolated = (i === 0 || Date.parse(p.date) - Date.parse(s.points[i - 1].date) !== COMPARISON_DAY) &&
          (i === s.points.length - 1 || Date.parse(s.points[i + 1].date) - Date.parse(p.date) !== COMPARISON_DAY);
        var tip = comparisonEscape(comparisonPointText(s, p));
        html += '<circle data-series="' + s.key + '" data-comparison-tip="' + tip + '" cx="' + g.x(p.date) + '" cy="' + g[s.axis].y(p.value) + '" r="5" fill="' + s.color + '" class="comparison-point' + (isolated ? ' comparison-isolated' : '') + '" tabindex="' + (i === 0 ? '0' : '-1') + '" role="img" aria-label="' + tip + '"><title>' + tip + '</title></circle>';
      });
    });
    html += '</svg>';
    if (!selected.length) html += '<p class="comparison-empty" role="status">' + (model.series.some(function (s) { return s.status === 'ok'; }) ? '所有可用曲线已隐藏，请点击图例恢复。' : '暂无可绘制数据，请查看各序列状态。') + '</p>';
    return html;
  }

  // All baseline-sensitive surfaces are derived together, including the live
  // readout; a mode change cannot leave an old tooltip/caption behind.
  function comparisonView(model, visible) {
    var base = model.baseLabel + ' ' + model.baseDate + '=100';
    return {
      chart: comparisonMarkup(model, visible), legend: comparisonLegend(model),
      description: 'Silicon Data LLM Token 综合有效价格与 Neo-cloud GPU 租赁价格走势。双轴均为线性：左轴 USD / 1M tokens；右轴 GPU 指数，' + base + '。',
      caption: 'Token保留Silicon Data综合有效价格，不做归一化。GPU 指数 = 当日 USD/GPU-hour ÷ 同型号 Neo-cloud 在 ' + model.baseDate + ' 的实际价格 × 100（' + model.baseLabel + '）。仅展示2026年实际观测，缺失日断线，不插值、不前向填充；各线截止各自实际观测日。',
      source: '当前基期：' + base + '。仅使用该日实际观测，无替代基期。',
      readout: '当前基期：' + base + '。请选择数据点查看读数。'
    };
  }

  // Comparison overview: DOM wiring
  function initComparison(doc) {
    var chart = document.getElementById('comparison-chart');
    var legend = document.getElementById('comparison-legend');
    var status = document.getElementById('comparison-status');
    var readout = document.getElementById('comparison-readout');
    var model = buildComparison(doc), visible = {};
    model.series.forEach(function (s) { visible[s.key] = s.status === 'ok'; });
    var baseControl = document.getElementById('comparison-base');
    function applyMode() {
      model = buildComparison(doc, baseControl.value);
      // An explicit mode selection restores every available curve.
      model.series.forEach(function (s) { visible[s.key] = s.status === 'ok'; });
      var view = comparisonView(model, visible);
      hideTooltip();
      if (tooltipEl) tooltipEl.textContent = '';
      legend.innerHTML = view.legend;
      chart.innerHTML = view.chart;
      status.textContent = comparisonStatus(model);
      document.getElementById('comparison-description').textContent = view.description;
      document.getElementById('comparison-caption').textContent = view.caption;
      document.getElementById('comparison-source-base').textContent = view.source;
      readout.textContent = view.readout;
    }
    baseControl.value = COMPARISON_BASE;
    baseControl.addEventListener('change', applyMode);
    function render() { hideTooltip(); chart.innerHTML = comparisonMarkup(model, visible); }
    legend.addEventListener('click', function (event) {
      var button = event.target.closest('[data-comparison-key]');
      if (!button || !toggleComparison(model, visible, button.getAttribute('data-comparison-key'))) return;
      button.setAttribute('aria-pressed', String(visible[button.getAttribute('data-comparison-key')]));
      readout.textContent = '曲线显示已更新。';
      render();
    });
    function reveal(event) {
      var point = event.target.closest('[data-comparison-tip]');
      if (!point) return;
      var text = point.getAttribute('data-comparison-tip');
      readout.textContent = text;
      var rect = point.getBoundingClientRect();
      showTooltip(Math.min(rect.left, window.innerWidth - 254), Math.min(rect.top, window.innerHeight - 140), text);
    }
    chart.addEventListener('pointerover', reveal);
    chart.addEventListener('click', reveal);
    chart.addEventListener('focusin', reveal);
    chart.addEventListener('pointerout', hideTooltip);
    chart.addEventListener('focusout', hideTooltip);
    qs('.comparison-scroll').addEventListener('scroll', hideTooltip);
    chart.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { hideTooltip(); return; }
      var point = event.target.closest('[data-comparison-tip]');
      if (!point || ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) === -1) return;
      event.preventDefault();
      var points = qsa('[data-comparison-tip]', chart).filter(function (p) { return p.getAttribute('data-series') === point.getAttribute('data-series'); });
      var index = points.indexOf(point);
      var next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1);
      next = Math.max(0, Math.min(points.length - 1, next));
      point.setAttribute('tabindex', '-1');
      points[next].setAttribute('tabindex', '0');
      points[next].focus();
    });
    applyMode();
  }
  // Comparison overview: end

  // ── toggle / range controls ──────────────────────────────────────────────
  function buildToggle(container, items, onChange) {
    container.textContent = '';
    var state = {};
    items.forEach(function (item) { state[item.key] = true; });
    items.forEach(function (item) {
      var btn = el('button', { type: 'button', class: 'toggle-btn', 'aria-pressed': 'true', style: '--swatch-color:' + item.color });
      btn.appendChild(el('span', { class: 'toggle-btn__swatch', 'aria-hidden': 'true' }));
      btn.appendChild(el('span', { text: item.label }));
      btn.addEventListener('click', function () {
        state[item.key] = !state[item.key];
        btn.setAttribute('aria-pressed', String(state[item.key]));
        onChange(state);
      });
      container.appendChild(btn);
    });
    return state;
  }

  function wireRangeControl(scope, onChange) {
    var buttons = qsa('.range-btn', scope);
    var current = 'all';
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        current = btn.getAttribute('data-range');
        onChange(current);
      });
    });
    return function () { return current; };
  }

  // ── token section ─────────────────────────────────────────────────────
  var TOKEN_LABELS = { expenditure: '综合', open_expenditure: '开放权重', closed_expenditure: '闭源' };
  // Portrait 2:3 viewBox keeps the three-card trend view readable without
  // visually exaggerating small moves as much as the earlier 1:2 layout.
  var TOKEN_CHART_W = 400, TOKEN_CHART_H = 600;

  function initToken(doc) {
    var block = doc.token;
    var section = document.getElementById('token');
    var kpiRow = document.getElementById('token-kpis');
    var chartEl = document.getElementById('token-chart');
    var caption = document.getElementById('token-caption');
    var toggleContainer = document.getElementById('token-toggles');
    var startInput = document.getElementById('token-date-start');
    var endInput = document.getElementById('token-date-end');
    var dateError = document.getElementById('token-date-error');
    var customRange = null;
    var datasetDates = unionDates(block.series);
    var minDate = datasetDates[0], maxDate = datasetDates[datasetDates.length - 1];
    var lastChartWidth = 0;
    [startInput, endInput].forEach(function (input, i) {
      if (datasetDates.length) {
        input.min = minDate;
        input.max = maxDate;
        input.value = i === 0 ? minDate : maxDate;
      }
    });

    function clearDateError() {
      dateError.hidden = true;
      dateError.textContent = '';
      startInput.removeAttribute('aria-invalid');
      endInput.removeAttribute('aria-invalid');
    }

    document.getElementById('token-date-apply').addEventListener('click', function () {
      var start = startInput.value, end = endInput.value;
      var error = !start || !end ? '请填写开始日期和结束日期。'
        : start > end ? '开始日期不能晚于结束日期。'
        : !datasetDates.length ? 'Token 暂无可选观测日期。'
        : start < minDate || end > maxDate ? '请选择 ' + minDate + ' 至 ' + maxDate + ' 内的日期。' : '';
      if (error) {
        dateError.textContent = error;
        dateError.hidden = false;
        startInput.setAttribute('aria-invalid', 'true');
        endInput.setAttribute('aria-invalid', 'true');
        return;
      }
      clearDateError();
      customRange = { start: start, end: end };
      qsa('.range-control .range-btn', section).forEach(function (btn) { btn.classList.remove('is-active'); });
      rerenderChart();
    });

    var items = block.series.map(function (s) {
      return { key: s.key, label: TOKEN_LABELS[s.key] || s.label_zh, color: 'var(--series-token-' + s.key + ')' };
    });
    var visibleState = buildToggle(toggleContainer, items, rerenderChart);
    var rangeGetter = wireRangeControl(qs('.range-control', section), function () {
      customRange = null;
      clearDateError();
      rerenderChart();
    });

    function visibleSeries() {
      return block.series.filter(function (s) { return visibleState[s.key]; }).map(function (s) {
        return {
          key: s.key,
          label: TOKEN_LABELS[s.key] || s.label_zh,
          color: 'var(--series-token-' + s.key + ')',
          observations: customRange ? s.observations.filter(function (o) {
            return o.date >= customRange.start && o.date <= customRange.end;
          }) : sliceByRange(s.observations, rangeGetter()),
        };
      });
    }

    // One card per visible series — a hidden series drops its whole card, and
    // each card scales to its own values instead of a shared y-domain.
    function rerenderChart() {
      var seriesList = visibleSeries();
      var single = seriesList.length === 1;
      section.classList.toggle('is-single', single);
      lastChartWidth = chartEl.getBoundingClientRect().width;
      chartEl.textContent = '';
      if (!seriesList.length) {
        chartEl.appendChild(el('p', { class: 'loading-copy', text: '当前筛选下暂无可绘制的数据。' }));
      }
      seriesList.forEach(function (series) {
        var plot = el('div', { class: 'token-chart-card__plot' });
        chartEl.appendChild(el('div', { class: 'token-chart-card' }, [
          el('h3', { class: 'token-chart-card__title', text: series.label }),
          plot,
        ]));
        var chartOptions = {
          decimals: 4,
          width: TOKEN_CHART_W, height: TOKEN_CHART_H,
          pad: { top: 14, right: 16, bottom: 34, left: 52 },
          yTicks: 6,
          xTickCount: 2,
          ariaLabel: 'Token ' + series.label + '支出指数走势图',
        };
        if (single) {
          // Match SVG units to rendered pixels: labels stay legible without
          // stretching the portrait viewBox. Hidden sections are measured later.
          var rect = plot.getBoundingClientRect();
          chartOptions.width = rect.width || TOKEN_CHART_W;
          chartOptions.height = rect.height || 340;
        }
        renderLineChart(plot, [series], chartOptions);
      });
      var dates = unionDates(seriesList);
      caption.textContent = dates.length
        ? (dates[0] + ' ~ ' + dates[dates.length - 1] + '，' + dates.length + ' 个观测日')
        : '当前筛选下暂无数据';
      if (customRange) {
        caption.textContent = '所选范围：' + customRange.start + ' ~ ' + customRange.end +
          '；实际观测：' + caption.textContent;
      }
    }

    function renderKpis() {
      kpiRow.textContent = '';
      if (!block.latest) {
        kpiRow.appendChild(el('p', { class: 'error-copy', text: 'Token 历史暂无成功观测。' }));
        return;
      }
      block.series.forEach(function (s) {
        var key = s.key;
        var meta = (s.latest ? s.latest.date : '暂无观测') + (block.freshness.stale ? '（滞后 ' + block.freshness.lag_days + ' 天）' : '');
        var tile = el('div', { class: 'kpi-tile' }, [
          el('p', { class: 'kpi-tile__label', text: TOKEN_LABELS[key] }),
          el('p', { class: 'kpi-tile__value', text: fmt(s.latest && s.latest.value, 4) }),
          el('p', { class: 'kpi-tile__meta', text: meta }),
        ]);
        kpiRow.appendChild(tile);
      });
    }

    renderKpis();
    rerenderChart();
    // Observe the stable row, not replaced SVGs; height-only notifications and
    // gated/hidden sections must not cause a render loop.
    if (window.ResizeObserver) {
      var resizeObserver = new ResizeObserver(function () {
        var width = chartEl.getBoundingClientRect().width;
        if (!section.hidden && section.classList.contains('is-single') && width > 0 && Math.abs(width - lastChartWidth) > 0.5) {
          rerenderChart();
        }
      });
      resizeObserver.observe(chartEl);
    }
  }

  // ── gpu section ───────────────────────────────────────────────────────
  // Bare accelerator names: the group is already named by the active group
  // button, so repeating "Neo-cloud" on all five card titles adds no signal.
  var GPU_MODEL_LABELS = {
    neo_h100: 'H100', neo_a100: 'A100', neo_h200: 'H200', neo_b200: 'B200', neo_mi300x: 'MI300X',
    hyper_h100: 'H100', hyper_a100: 'A100', neo_b300: 'B300',
  };
  var GPU_DISPLAY_ORDER = ['neo_b300', 'neo_b200', 'neo_h100', 'neo_a100', 'neo_h200', 'neo_mi300x', 'hyper_h100', 'hyper_a100'];
  function orderSeries(list, keys) {
    return list.slice().sort(function (a, b) {
      var ai = keys.indexOf(a.key), bi = keys.indexOf(b.key);
      return (ai < 0 ? keys.length : ai) - (bi < 0 ? keys.length : bi);
    });
  }
  // Portrait 2:3 small multiples, same ratio as the Token cards. All six
  // Neo-cloud cards fit one desktop row; each is drawn alone so it owns its y-domain, which the shared
  // wide chart flattened into near-straight lines.
  var GPU_CHART_W = 240, GPU_CHART_H = 360;

  function initGpu(doc) {
    var block = doc.gpu;
    var section = document.getElementById('gpu');
    var kpiRow = document.getElementById('gpu-kpis');
    var chartEl = document.getElementById('gpu-chart');
    var caption = document.getElementById('gpu-caption');
    var toggleContainer = document.getElementById('gpu-toggles');
    var groupButtons = qsa('.group-btn', section);
    var currentGroup = 'neo';
    var visibleState = {};

    var rangeGetter = wireRangeControl(qs('.controls', section), rerenderChart);

    function seriesForGroup(group) {
      return orderSeries(block.series.filter(function (s) { return s.group === group; }), GPU_DISPLAY_ORDER);
    }

    function buildToggles() {
      var items = seriesForGroup(currentGroup).map(function (s) {
        return { key: s.key, label: s.label_zh, color: 'var(--series-gpu-' + s.key + ')' };
      });
      visibleState = buildToggle(toggleContainer, items, rerenderChart);
    }

    function visibleSeries() {
      return seriesForGroup(currentGroup).filter(function (s) { return visibleState[s.key]; }).map(function (s) {
        return {
          key: s.key,
          label: s.label_zh,
          short: GPU_MODEL_LABELS[s.key] || s.label_zh,
          color: 'var(--series-gpu-' + s.key + ')',
          observations: sliceByRange(s.observations, rangeGetter()),
        };
      });
    }

    // One card per visible series — a hidden series drops its whole card, and
    // each card scales to its own values instead of a shared y-domain.
    function rerenderChart() {
      var seriesList = visibleSeries();
      chartEl.textContent = '';
      chartEl.setAttribute('data-group', currentGroup);
      if (!seriesList.length) {
        chartEl.appendChild(el('p', { class: 'loading-copy', text: '当前筛选下暂无可绘制的数据。' }));
      }
      seriesList.forEach(function (series) {
        var plot = el('div', { class: 'gpu-chart-card__plot' });
        chartEl.appendChild(el('div', { class: 'gpu-chart-card' }, [
          el('h3', { class: 'gpu-chart-card__title', text: series.short }),
          plot,
        ]));
        renderLineChart(plot, [series], {
          decimals: 2,
          axisDecimals: 3,
          width: GPU_CHART_W, height: GPU_CHART_H,
          pad: { top: 12, right: 14, bottom: 32, left: 42 },
          yTicks: 5,
          xTickCount: 2,
          ariaLabel: series.label + ' 租赁基准指数走势图',
        });
      });
      var dates = unionDates(seriesList);
      caption.textContent = dates.length
        ? (dates[0] + ' ~ ' + dates[dates.length - 1] + '，' + dates.length + ' 个观测日')
        : '当前筛选下暂无数据';
    }

    function renderKpis() {
      kpiRow.textContent = '';
      if (!block.latest) {
        kpiRow.appendChild(el('p', { class: 'error-copy', text: 'GPU 历史暂无成功观测。' }));
        return;
      }
      seriesForGroup(currentGroup).forEach(function (s) {
        var tile = el('div', { class: 'kpi-tile' }, [
          el('p', { class: 'kpi-tile__label', text: s.label_zh }),
          el('p', { class: 'kpi-tile__value', text: fmt(s.latest && s.latest.value, 2) }),
          el('p', { class: 'kpi-tile__meta', text: s.latest ? s.latest.date : '暂无观测' }),
        ]);
        kpiRow.appendChild(tile);
      });
    }


    function setGroup(group) {
      currentGroup = group;
      groupButtons.forEach(function (b) {
        var active = b.getAttribute('data-group') === group;
        b.classList.toggle('is-active', active);
      });
      buildToggles();
      renderKpis();
      rerenderChart();
    }

    groupButtons.forEach(function (b) {
      b.addEventListener('click', function () { setGroup(b.getAttribute('data-group')); });
    });

    setGroup('neo');
  }

  // ── shared status labels (ok/stale/partial/failed/unknown) ─────────────
  var STATUS_LABELS = {
    ok: '正常',
    stale: '陈旧（最近观测滞后）',
    partial: '部分来源未更新，含明确标记的历史报价',
    failed: '采集失败，展示的是历史数据',
    unknown: '状态未知',
  };
  function statusLabel(status) { return STATUS_LABELS[status] || STATUS_LABELS.unknown; }
  function statusClass(status) { return 'is-' + (STATUS_LABELS[status] ? status : 'unknown'); }

  function rateStatusLabel(o) {
    var labels = { ok: '正常', failed: '获取失败', empty: '无新报价', unknown: '状态未知' };
    return (labels[o.provider_status] || labels.unknown) + (o.retained_history ? ' · 历史报价（保留）' : '');
  }

  // ── rates section ─────────────────────────────────────────────────────
  function initRates(doc) {
    var block = doc.rates;
    var overall = doc.status && doc.status.rates_overall;
    var statusEl = document.getElementById('rates-status');
    if (statusEl) {
      statusEl.textContent = '目录报价状态：' + statusLabel(overall) +
        (block.freshness && block.freshness.latest_date
          ? '（最近观测 ' + block.freshness.latest_date + '，滞后 ' + block.freshness.lag_days + ' 天，共 ' + block.coverage.count + ' 条）'
          : '');
      statusEl.className = 'panel__status ' + statusClass(overall);
    }
    var cardsEl = document.getElementById('rates-cards');
    var tableBody = qs('#rates-table tbody');
    var providerFilter = document.getElementById('rates-provider-filter');
    var gpuFilter = document.getElementById('rates-gpu-filter');

    uniqueSorted(block.observations.map(function (o) { return o.provider; })).forEach(function (p) {
      providerFilter.appendChild(el('option', { value: p, text: p }));
    });
    uniqueSorted(block.observations.map(function (o) { return o.gpu_model; })).forEach(function (m) {
      gpuFilter.appendChild(el('option', { value: m, text: m }));
    });

    function currentRows() {
      return block.observations.filter(function (o) {
        return (providerFilter.value === 'all' || o.provider === providerFilter.value) &&
          (gpuFilter.value === 'all' || o.gpu_model === gpuFilter.value);
      });
    }

    function render() {
      var rows = currentRows();
      cardsEl.textContent = '';
      tableBody.textContent = '';
      if (!rows.length) {
        cardsEl.appendChild(el('p', { class: 'loading-copy', text: '当前筛选下暂无目录报价。' }));
        tableBody.appendChild(el('tr', {}, [el('td', { colspan: '10', text: '当前筛选下暂无目录报价。' })]));
        return;
      }
      rows.forEach(function (o) {
        var dl = el('dl');
        [
          ['产品/层级', o.product + ' / ' + o.tier],
          ['地区', o.region || '未提供'],
          ['合约', o.contract],
          ['USD/GPU-hour', fmt(o.usd_per_gpu_hour, 2)],
          ['发布价格', fmt(o.published_price, 2) + ' ' + o.published_unit],
          ['最后确认(UTC)', o.last_seen_at_utc],
          ['观测日期', o.observation_date],
          ['来源状态', rateStatusLabel(o)],
        ].forEach(function (pair) {
          dl.appendChild(el('dt', { text: pair[0] }));
          dl.appendChild(el('dd', { text: pair[1] }));
        });
        var sourceLine = el('p', { class: 'source-line' }, [
          document.createTextNode('来源：'),
          el('a', { href: o.source_url, text: '原始来源' }),
        ]);
        cardsEl.appendChild(el('article', { class: 'rate-card' }, [
          el('h3', { text: o.provider + ' · ' + o.gpu_variant }),
          dl,
          sourceLine,
        ]));

        var tr = el('tr', {}, [
          el('td', { text: o.provider + ' · ' + rateStatusLabel(o) }),
          el('td', { text: o.gpu_variant }),
          el('td', { text: fmt(o.usd_per_gpu_hour, 2) }),
          el('td', { text: fmt(o.published_price, 2) }),
          el('td', { text: o.published_unit }),
          el('td', { text: o.product + ' / ' + o.tier }),
          el('td', { text: o.region || '未提供' }),
          el('td', { text: o.contract }),
          el('td', { text: o.last_seen_at_utc }),
        ]);
        var linkTd = el('td', {}, [el('a', { href: o.source_url, text: '原始来源' })]);
        tr.appendChild(linkTd);
        tableBody.appendChild(tr);
      });
    }

    providerFilter.addEventListener('change', render);
    gpuFilter.addEventListener('change', render);
    render();
  }

  // ── runtime status (page bottom) ──────────────────────────────────────
  var ORNN_CHART_W = 240, ORNN_CHART_H = 360;
  var ORNN_DISPLAY_ORDER = ['b200', 'h100_sxm', 'a100_sxm4', 'h200', 'rtx_5090'];
  function initOrnn(doc) {
    var block = doc.ornn;
    var series = orderSeries(block.series, ORNN_DISPLAY_ORDER);
    var section = document.getElementById('ornn');
    var chartEl = document.getElementById('ornn-chart');
    var caption = document.getElementById('ornn-caption');
    var kpis = document.getElementById('ornn-kpis');
    var status = doc.status.ornn.status;
    var freshness = block.freshness;
    var statusEl = document.getElementById('ornn-status');
    statusEl.textContent = statusLabel(status) + (freshness.latest_date ? ' · 最近观测 ' + freshness.latest_date + ' · 滞后 ' + freshness.lag_days + ' 天' : ' · 暂无观测');
    statusEl.className = 'panel__status ' + statusClass(status === 'failed' ? status : freshness.stale ? 'stale' : status);
    var rangeGetter = wireRangeControl(qs('.controls', section), render);
    var visible = buildToggle(document.getElementById('ornn-toggles'), series.map(function (s) {
      return { key: s.key, label: s.label, color: 'var(--series-ornn-' + s.key + ')' };
    }), render);
    kpis.textContent = '';
    series.forEach(function (s) {
      kpis.appendChild(el('div', { class: 'kpi-tile' }, [
        el('p', { class: 'kpi-tile__label', text: s.label }),
        el('p', { class: 'kpi-tile__value', text: fmt(s.latest && s.latest.value, 2) }),
        el('p', { class: 'kpi-tile__meta', text: s.latest ? s.latest.date : '暂无观测' }),
      ]));
    });
    function render() {
      chartEl.textContent = '';
      var selected = series.filter(function (s) { return visible[s.key]; }).map(function (s) {
        return { key: s.key, label: s.label, color: 'var(--series-ornn-' + s.key + ')', observations: sliceByRange(s.observations, rangeGetter()) };
      });
      selected.forEach(function (series) {
        var plot = el('div', { class: 'ornn-chart-card__plot' });
        chartEl.appendChild(el('div', { class: 'ornn-chart-card' }, [el('h3', { class: 'ornn-chart-card__title', text: series.label }), plot]));
        renderLineChart(plot, [series], {
          decimals: 2, axisDecimals: 3, width: ORNN_CHART_W, height: ORNN_CHART_H,
          pad: { top: 12, right: 14, bottom: 32, left: 42 }, yTicks: 5, xTickCount: 2,
          ariaLabel: 'Ornn ' + series.label + ' 日度结算指数走势图',
        });
      });
      var dates = unionDates(selected);
      caption.textContent = dates.length ? dates[0] + ' ~ ' + dates[dates.length - 1] + '，' + dates.length + ' 个观测日' : '当前筛选下暂无数据';
    }
    render();
  }

  // ── Ornn OTPI helpers ─────────────────────────────────────────────────
  // Explicit publication mode supplies four whitelisted series through the
  // normal dashboard fetch, after the existing general visitor gate.
  var OTPI_DISPLAY_ORDER = ['anthropic', 'openai', 'google', 'deepseek'];
  var OTPI_FEATURED = 'anthropic';
  var OTPI_CHANGE_WINDOWS = [['1D', 1], ['7D', 7], ['30D', 30]];

  // Change against the settlement exactly `days` calendar days before the
  // series' own latest one; without that exact date there is no change.
  function exactChange(observations, days) {
    if (!observations.length) return null;
    var latest = observations[observations.length - 1];
    var baseDate = addDaysISO(latest.date, -days);
    for (var i = observations.length - 1; i >= 0 && observations[i].date >= baseDate; i--) {
      if (observations[i].date === baseDate && observations[i].value > 0) {
        return { base: observations[i], pct: (latest.value - observations[i].value) / observations[i].value };
      }
    }
    return null;
  }
  function formatChange(change) {
    return change ? (change.pct >= 0 ? '+' : '') + (change.pct * 100).toFixed(1) + '%' : '暂无';
  }
  // A failed last run or stale data must never read as fresh.
  function otpiStatusKey(status, freshness) {
    if (status === 'failed') return 'failed';
    if (freshness && freshness.stale) return 'stale';
    return STATUS_LABELS[status] ? status : 'unknown';
  }
  function lagBehind(blockLatest, seriesLatest) {
    return Math.round((Date.parse(blockLatest) - Date.parse(seriesLatest)) / 86400000);
  }

  function initOtpi(doc) {
    var block = doc.otpi;
    if (!block || !Array.isArray(block.series)) return;
    ['otpi', 'nav-otpi', 'method-otpi', 'footer-otpi'].forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.hidden = false;
    });
    var section = document.getElementById('otpi');
    if (section) {
      var controls = qs('.controls', section);
      if (controls && controls.parentNode) controls.parentNode.replaceChild(controls.cloneNode(true), controls);
    }
    var series = orderSeries(block.series, OTPI_DISPLAY_ORDER);
    var kpis = document.getElementById('otpi-kpis');
    var chartEl = document.getElementById('otpi-chart');
    var caption = document.getElementById('otpi-caption');
    var statusEl = document.getElementById('otpi-status');
    var collection = block.collection || {};
    var freshness = block.freshness || {};
    var key = otpiStatusKey(collection.status, freshness);
    var parts = [statusLabel(key), freshness.latest_date ? '最近结算日 ' + freshness.latest_date + ' · 滞后 ' + freshness.lag_days + ' 天' : '暂无结算值',
      '最近成功采集 ' + (collection.last_success_at_utc || '暂无')];
    if (collection.attempted_at_utc && collection.attempted_at_utc !== collection.last_success_at_utc) {
      parts.push('最近尝试 ' + collection.attempted_at_utc);
    }
    statusEl.textContent = parts.join(' · ');
    statusEl.className = 'panel__status ' + statusClass(key);

    kpis.textContent = '';
    series.forEach(function (s) {
      var featured = s.key === OTPI_FEATURED;
      var lag = s.latest && freshness.latest_date ? lagBehind(freshness.latest_date, s.latest.date) : 0;
      var tile = el('div', { class: featured ? 'kpi-tile is-featured' : 'kpi-tile' }, [
        el('p', { class: 'kpi-tile__label', text: featured ? 'Ornn ' + s.label + ' Token Price Index' : s.label }),
        el('p', { class: 'kpi-tile__value-line' }, [
          el('span', { class: 'kpi-tile__value', text: fmt(s.latest && s.latest.value, 4) }),
          el('span', { class: 'kpi-tile__value-unit', text: 'USD/百万 Token' }),
        ]),
        el('p', { class: 'kpi-tile__meta', text: s.latest ? '结算日 ' + s.latest.date + (lag > 0 ? '（落后最新结算日 ' + lag + ' 天）' : '') : '暂无结算值' }),
        el('p', { class: 'otpi-kpi__changes' }, OTPI_CHANGE_WINDOWS.map(function (w) {
          return el('span', { text: w[0] + ' ' + formatChange(exactChange(s.observations, w[1])) });
        })),
      ]);
      if (featured && s.latest) tile.appendChild(el('p', { class: 'kpi-tile__meta', text: 'Ornn 计算于 ' + s.latest.computed_at }));
      kpis.appendChild(tile);
    });

    var rangeGetter = wireRangeControl(qs('.controls', section), render);
    var visible = buildToggle(document.getElementById('otpi-toggles'), series.map(function (s) {
      return { key: s.key, label: s.label, color: 'var(--series-otpi-' + s.key + ')' };
    }), render);
    function render() {
      chartEl.textContent = '';
      // One common date window anchored to the source's latest observation,
      // independent of legend selection; stale labs do not move the axis.
      var allDates = unionDates(series);
      var days = RANGE_DAYS[rangeGetter()];
      var cutoff = days && allDates.length ? addDaysISO(allDates[allDates.length - 1], -(days - 1)) : '';
      var selected = series.filter(function (s) { return visible[s.key]; }).map(function (s) {
        return { key: s.key, label: s.label, color: 'var(--series-otpi-' + s.key + ')',
          observations: s.observations.filter(function (o) { return !cutoff || o.date >= cutoff; }) };
      });
      var width = Math.max(280, Math.round(chartEl.clientWidth || Math.min(1000, (window.innerWidth || 960) - 64)));
      renderLineChart(chartEl, selected, {
        decimals: 4, axisDecimals: 4, width: width, height: width < 600 ? 300 : 360,
        pad: { top: 16, right: 12, bottom: 34, left: 66 }, yTicks: 4,
        xTickCount: width < 600 ? 2 : 3, breakDailyGaps: true,
        domainDates: allDates.filter(function (d) { return !cutoff || d >= cutoff; }),
        ariaLabel: 'Anthropic、OpenAI、Google、DeepSeek Token 价格指数；共享日期轴与 USD / 1M tokens 价格轴，未归一化',
      });
      var dates = unionDates(selected);
      caption.textContent = dates.length
        ? dates[0] + ' ~ ' + dates[dates.length - 1] + '，' + dates.length + ' 个结算日；四家共享日期轴及价格轴（USD / 1M tokens），未归一化；只画实际结算值，缺失日断线。'
        : '当前筛选下暂无数据';
    }
    window.addEventListener('resize', render);
    render();
  }

  function showOtpiFailure(err) {
    var statusEl = document.getElementById('otpi-status');
    if (!statusEl) return;
    statusEl.textContent = 'Ornn OTPI 渲染失败（' + (err && err.message ? err.message : '未知错误') + '）';
    statusEl.className = 'panel__status is-failed';
  }

  function statusCard(label, value, cls) {
    return el('div', { class: 'status-card' }, [
      el('p', { class: 'status-card__label', text: label }),
      el('p', { class: 'status-card__value' + (cls ? ' ' + cls : ''), text: value }),
    ]);
  }

  function initRuntimeStatus(doc) {
    var statusEl = document.getElementById('runtime-status');
    statusEl.textContent = '';
    statusEl.appendChild(statusCard('数据生成时间 (UTC)', doc.generated_at_utc));
    statusEl.appendChild(statusCard(
      'Token 新鲜度',
      doc.token.freshness.latest_date ? (doc.token.freshness.latest_date + ' · 滞后 ' + doc.token.freshness.lag_days + ' 天') : '暂无观测',
      doc.token.freshness.stale ? 'is-stale' : 'is-ok'
    ));
    // Series keep their own windows (B300 is collected apart from the wide
    // table), so report the stalest series: a fresh B300 must not mask the rest.
    var gpuLatest = doc.gpu.series.filter(function (s) { return s.latest; }).map(function (s) { return s.latest.date; }).sort()[0];
    var gpuLag = gpuLatest ? doc.gpu.freshness.lag_days + Math.round((Date.parse(doc.gpu.freshness.latest_date) - Date.parse(gpuLatest)) / 86400000) : null;
    statusEl.appendChild(statusCard(
      'GPU 新鲜度',
      gpuLatest ? (gpuLatest + ' · 滞后 ' + gpuLag + ' 天') : '暂无观测',
      !gpuLatest || gpuLag >= 4 ? 'is-stale' : 'is-ok'
    ));
    statusEl.appendChild(statusCard('Ornn GPU 新鲜度', doc.ornn.freshness.latest_date ? doc.ornn.freshness.latest_date + ' · 滞后 ' + doc.ornn.freshness.lag_days + ' 天 · ' + statusLabel(doc.status.ornn.status) : '暂无观测', statusClass(doc.status.ornn.status === 'failed' ? 'failed' : doc.ornn.freshness.stale ? 'stale' : doc.status.ornn.status)));
    if (doc.otpi && doc.otpi.freshness) {
      var otpiKey = otpiStatusKey(doc.otpi.collection && doc.otpi.collection.status, doc.otpi.freshness);
      statusEl.appendChild(statusCard('Ornn OTPI 新鲜度', doc.otpi.freshness.latest_date ? doc.otpi.freshness.latest_date + ' · 滞后 ' + doc.otpi.freshness.lag_days + ' 天 · ' + statusLabel(otpiKey) : '暂无观测', statusClass(otpiKey)));
    }
    var pipelineKeys = Object.keys(doc.status.pipeline);
    var pipelineOk = pipelineKeys.length > 0 && pipelineKeys.every(function (k) { return doc.status.pipeline[k].status === 'ok'; });
    statusEl.appendChild(statusCard('Token/GPU 采集管道', pipelineOk ? '正常' : '存在失败，见上方口径说明', pipelineOk ? 'is-ok' : 'is-stale'));
    var ratesOverall = doc.status.rates_overall;
    statusEl.appendChild(statusCard('供应商报价状态', statusLabel(ratesOverall), statusClass(ratesOverall)));
  }

  // ── keyboard section navigation ───────────────────────────────────────
  function initKeyboardNav() {
    var map = { t: 'token', i: 'otpi', g: 'gpu', o: 'ornn', r: 'rates', m: 'method' };
    document.addEventListener('keydown', function (evt) {
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
      var target = evt.target;
      var tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
      var key = evt.key ? evt.key.toLowerCase() : '';
      var id = map[key];
      if (!id) return;
      var section = document.getElementById(id);
      if (!section || section.hidden) return;
      section.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
      section.focus({ preventScroll: true });
    });
  }

  // ── boot ─────────────────────────────────────────────────────────────
  function showFailure(message) {
    qsa('.loading-copy').forEach(function (node) {
      node.textContent = message;
      node.classList.add('error-copy');
    });
    var statusEl = document.getElementById('runtime-status');
    statusEl.textContent = '';
    statusEl.appendChild(el('p', { class: 'error-copy', text: message }));
  }

  // The full dashboard only loads after the access gate (gate.js) unlocks it,
  // so gated sections never fetch or render for anonymous visitors. gate.js
  // marks html[data-barry-unlocked] and fires barry:unlocked; either signal
  // boots exactly once, whichever arrives first.
  var UNLOCK_EVENT = (window.BarryAccess && window.BarryAccess.UNLOCK_EVENT) || 'barry:unlocked';
  var booted = false;

  function init() {
    if (booted) return;
    booted = true;
    initKeyboardNav();
    fetch(DATA_URL, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (doc) {
        initRuntimeStatus(doc);
        initToken(doc);
        initGpu(doc);
        initOrnn(doc);
        initRates(doc);
        try { initOtpi(doc); } catch (err) { showOtpiFailure(err); }
        initComparison(doc);
      })
      .catch(function (err) {
        showFailure('数据加载失败，请稍后刷新重试。（' + (err && err.message ? err.message : '未知错误') + '）');
      });
  }

  function isUnlocked() {
    return document.documentElement.getAttribute('data-barry-unlocked') === '1';
  }

  function boot() {
    if (isUnlocked()) { init(); return; }
    window.addEventListener(UNLOCK_EVENT, init, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
