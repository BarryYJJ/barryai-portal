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
  function sliceByRange(observations, range) {
    if (range === 'all' || !observations.length) return observations;
    var days = range === '7d' ? 7 : 30;
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

    var dates = unionDates(seriesList);
    if (!dates.length || !seriesList.length) {
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
      var pathData = points.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2); }).join(' ');
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

    var items = block.series.map(function (s) {
      return { key: s.key, label: TOKEN_LABELS[s.key] || s.label_zh, color: 'var(--series-token-' + s.key + ')' };
    });
    var visibleState = buildToggle(toggleContainer, items, rerenderChart);
    var rangeGetter = wireRangeControl(qs('.controls', section), rerenderChart);

    function visibleSeries() {
      return block.series.filter(function (s) { return visibleState[s.key]; }).map(function (s) {
        return {
          key: s.key,
          label: TOKEN_LABELS[s.key] || s.label_zh,
          color: 'var(--series-token-' + s.key + ')',
          observations: sliceByRange(s.observations, rangeGetter()),
        };
      });
    }

    // One card per visible series — a hidden series drops its whole card, and
    // each card scales to its own values instead of a shared y-domain.
    function rerenderChart() {
      var seriesList = visibleSeries();
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
        renderLineChart(plot, [series], {
          decimals: 4,
          width: TOKEN_CHART_W, height: TOKEN_CHART_H,
          pad: { top: 14, right: 16, bottom: 34, left: 52 },
          yTicks: 6,
          xTickCount: 2,
          ariaLabel: 'Token ' + series.label + '支出指数走势图',
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
  }

  // ── gpu section ───────────────────────────────────────────────────────
  // Bare accelerator names: the group is already named by the active group
  // button, so repeating "Neo-cloud" on all five card titles adds no signal.
  var GPU_MODEL_LABELS = {
    neo_h100: 'H100', neo_a100: 'A100', neo_h200: 'H200', neo_b200: 'B200', neo_mi300x: 'MI300X',
    hyper_h100: 'H100', hyper_a100: 'A100',
  };
  // Portrait 2:3 small multiples, same ratio as the Token cards. Five fit one
  // desktop row; each is drawn alone so it owns its y-domain, which the shared
  // wide chart flattened into near-straight lines.
  var GPU_CHART_W = 240, GPU_CHART_H = 360;

  function initGpu(doc) {
    var block = doc.gpu;
    var section = document.getElementById('gpu');
    var kpiRow = document.getElementById('gpu-kpis');
    var chartEl = document.getElementById('gpu-chart');
    var caption = document.getElementById('gpu-caption');
    var tableHead = document.getElementById('gpu-table-head');
    var tableBody = qs('#gpu-table tbody');
    var toggleContainer = document.getElementById('gpu-toggles');
    var groupButtons = qsa('.group-btn', section);
    var currentGroup = 'neo';
    var visibleState = {};

    var rangeGetter = wireRangeControl(qs('.controls', section), rerenderChart);

    function seriesForGroup(group) {
      return block.series.filter(function (s) { return s.group === group; });
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

    function renderTable() {
      var seriesList = seriesForGroup(currentGroup);
      tableHead.textContent = '';
      tableHead.appendChild(el('th', { scope: 'col', text: '日期' }));
      seriesList.forEach(function (s) { tableHead.appendChild(el('th', { scope: 'col', text: s.label_zh })); });
      tableBody.textContent = '';
      var dates = unionDates(seriesList);
      if (!dates.length) {
        tableBody.appendChild(el('tr', {}, [el('td', { text: '暂无数据' })]));
        return;
      }
      dates.forEach(function (d) {
        var row = el('tr', {}, [el('td', { text: d })]);
        seriesList.forEach(function (s) { row.appendChild(el('td', { text: fmt(valueAt(s, d), 2) })); });
        tableBody.appendChild(row);
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
      renderTable();
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
  function initOrnn(doc) {
    var block = doc.ornn;
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
    var visible = buildToggle(document.getElementById('ornn-toggles'), block.series.map(function (s) {
      return { key: s.key, label: s.label, color: 'var(--series-ornn-' + s.key + ')' };
    }), render);
    kpis.textContent = '';
    block.series.forEach(function (s) {
      kpis.appendChild(el('div', { class: 'kpi-tile' }, [
        el('p', { class: 'kpi-tile__label', text: s.label }),
        el('p', { class: 'kpi-tile__value', text: fmt(s.latest && s.latest.value, 2) }),
        el('p', { class: 'kpi-tile__meta', text: s.latest ? s.latest.date : '暂无观测' }),
      ]));
    });
    function render() {
      chartEl.textContent = '';
      var selected = block.series.filter(function (s) { return visible[s.key]; }).map(function (s) {
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
    statusEl.appendChild(statusCard(
      'GPU 新鲜度',
      doc.gpu.freshness.latest_date ? (doc.gpu.freshness.latest_date + ' · 滞后 ' + doc.gpu.freshness.lag_days + ' 天') : '暂无观测',
      doc.gpu.freshness.stale ? 'is-stale' : 'is-ok'
    ));
    statusEl.appendChild(statusCard('Ornn GPU 新鲜度', doc.ornn.freshness.latest_date ? doc.ornn.freshness.latest_date + ' · 滞后 ' + doc.ornn.freshness.lag_days + ' 天 · ' + statusLabel(doc.status.ornn.status) : '暂无观测', statusClass(doc.status.ornn.status === 'failed' ? 'failed' : doc.ornn.freshness.stale ? 'stale' : doc.status.ornn.status)));
    var pipelineKeys = Object.keys(doc.status.pipeline);
    var pipelineOk = pipelineKeys.length > 0 && pipelineKeys.every(function (k) { return doc.status.pipeline[k].status === 'ok'; });
    statusEl.appendChild(statusCard('Token/GPU 采集管道', pipelineOk ? '正常' : '存在失败，见上方口径说明', pipelineOk ? 'is-ok' : 'is-stale'));
    var ratesOverall = doc.status.rates_overall;
    statusEl.appendChild(statusCard('供应商报价状态', statusLabel(ratesOverall), statusClass(ratesOverall)));
  }

  // ── keyboard section navigation ───────────────────────────────────────
  function initKeyboardNav() {
    var map = { t: 'token', g: 'gpu', o: 'ornn', r: 'rates', m: 'method' };
    document.addEventListener('keydown', function (evt) {
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
      var target = evt.target;
      var tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
      var key = evt.key ? evt.key.toLowerCase() : '';
      var id = map[key];
      if (!id) return;
      var section = document.getElementById(id);
      if (!section) return;
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

  function init() {
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
      })
      .catch(function (err) {
        showFailure('数据加载失败，请稍后刷新重试。（' + (err && err.message ? err.message : '未知错误') + '）');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
