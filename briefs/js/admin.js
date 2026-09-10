// Admin：URL 带 ?key=xxx 才能进，从 admin_list 云函数拉三个产品统一的线索 + 近 30 天访问统计
// 产品标签来自共享适配器 BarryAccess.PRODUCTS，保证与前端 / 后端契约一致
(function () {
  const KEY = new URLSearchParams(location.search).get('key');
  const loadingEl  = document.getElementById('loading');
  const authEl     = document.getElementById('auth-prompt');
  const tableEl    = document.getElementById('visitors-table');
  const bodyEl     = document.getElementById('visitors-body');
  const productsEl = document.getElementById('product-stats');
  const warnEl     = document.getElementById('admin-warnings');
  const filterEl   = document.getElementById('product-filter');
  const A = window.BarryAccess;
  const COLS = 10;

  if (!KEY) {
    loadingEl.hidden = true;
    authEl.hidden = false;
    return;
  }

  function productLabel(id) {
    return (A && A.PRODUCTS[id] && A.PRODUCTS[id].label) || id || '—';
  }

  async function init() {
    loadingEl.hidden = false;
    loadingEl.textContent = '加载中…';
    authEl.hidden = true;
    tableEl.hidden = true;
    productsEl.hidden = true;
    warnEl.hidden = true;

    try {
      const cb = await window.cbReady;
      const res = await cb.callFunction({
        name: 'admin_list',
        data: { admin_key: KEY, product: filterEl.value || '' },
      });
      const r = res.result || {};
      if (r.error) {
        loadingEl.textContent = '认证失败：' + r.error;
        return;
      }
      render(r);
    } catch (e) {
      loadingEl.textContent = '加载错误：' + (e.message || e);
    }
  }

  function render(r) {
    const items = r.items || [];
    loadingEl.hidden = true;
    tableEl.hidden = false;

    // 顶部统计（后端按北京时间口径算好，前端只展示）
    const totals = r.totals || {};
    document.getElementById('stat-total').textContent = num(totals.leads, items.length);
    document.getElementById('stat-today').textContent = num(totals.visitors_today, 0);
    document.getElementById('stat-week').textContent  = num(totals.visits_7d, r.total_visits_week || 0);
    document.getElementById('stat-visits-week').textContent = num(totals.visits_30d, 0);

    // 各产品分栏
    const products = r.products || [];
    const byProduct = r.by_product || {};
    if (products.length) {
      productsEl.innerHTML = products.map(p => {
        const b = byProduct[p.id] || {};
        return `
          <div class="product-tile">
            <h3>${esc(p.label)}<span class="product-id">${esc(p.id)}</span></h3>
            <dl>
              <div><dt>线索</dt><dd>${num(b.leads, 0)}</dd></div>
              <div><dt>今日访客</dt><dd>${num(b.visitors_today, 0)}</dd></div>
              <div><dt>7 日访问</dt><dd>${num(b.visits_7d, 0)}</dd></div>
              <div><dt>30 日访问</dt><dd>${num(b.visits_30d, 0)}</dd></div>
            </dl>
          </div>`;
      }).join('');
      productsEl.hidden = false;
    }

    // 上限 / 截断提示
    const warnings = r.warnings || [];
    if (warnings.length) {
      warnEl.textContent = warnings.join('；');
      warnEl.hidden = false;
    }

    // 表格
    const html = items.length ? items.map((it, idx) => {
      const count = it.visit_count_30d != null ? it.visit_count_30d : (it.visit_count || 0);
      const hasVisits = count > 0;
      const visitsHtml = hasVisits ? renderVisits(it) : '';
      const freq = hasVisits
        ? `<div class="visit-freq">${num(it.visit_days_30d, 0)} 天 · ${fmtFreq(it.visits_per_week)}/周</div>`
        : '';
      const toggleBtn = hasVisits
        ? `<button class="visit-toggle" data-row="${idx}" aria-expanded="false" aria-controls="vd-${idx}">${count} 次 <span class="caret">▾</span></button>`
        : `<span class="visit-zero">0 次</span>`;

      return `
        <tr>
          <td class="ts">${esc(fmtTs(it.ts))}</td>
          <td>${esc(it.name)}</td>
          <td>${esc(it.org)}</td>
          <td>${esc(it.contact)}</td>
          <td><span class="product-badge p-${esc(it.product)}">${esc(productLabel(it.product))}</span></td>
          <td class="muted">${esc(it.msg || '—')}</td>
          <td class="muted">${esc(it.ip || '—')}</td>
          <td class="ts">${it.first_visit ? esc(fmtTs(it.first_visit)) : '<span class="muted">—</span>'}</td>
          <td class="ts">${it.last_visit ? esc(fmtTs(it.last_visit)) : '<span class="muted">—</span>'}</td>
          <td class="visit-cell">${toggleBtn}${freq}${renderProductCounts(it.product_counts)}</td>
        </tr>
        <tr class="visit-detail-row" id="vd-${idx}" hidden>
          <td colspan="${COLS}" class="visit-detail-cell">${visitsHtml}</td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="${COLS}" class="muted" style="text-align:center;padding:30px;">还没人填过表</td></tr>`;
    bodyEl.innerHTML = html;

    // 绑定折叠按钮
    bodyEl.querySelectorAll('.visit-toggle').forEach(btn => {
      btn.onclick = () => {
        const row = document.getElementById('vd-' + btn.dataset.row);
        const isOpen = !row.hidden;
        row.hidden = isOpen;
        btn.querySelector('.caret').textContent = isOpen ? '▾' : '▴';
        btn.classList.toggle('open', !isOpen);
        btn.setAttribute('aria-expanded', String(!isOpen));
      };
    });

    // 搜索
    const search = document.getElementById('search');
    search.oninput = (e) => {
      const q = e.target.value.toLowerCase();
      const trs = bodyEl.querySelectorAll('tr:not(.visit-detail-row)');
      trs.forEach((tr, i) => {
        const detail = bodyEl.querySelectorAll('.visit-detail-row')[i];
        const match = tr.textContent.toLowerCase().includes(q);
        tr.style.display = match ? '' : 'none';
        if (detail) detail.style.display = match ? '' : 'none';
      });
    };
  }

  function renderProductCounts(counts) {
    if (!counts) return '';
    const parts = Object.keys(counts).filter(k => counts[k] > 0).map(k => `${esc(productLabel(k))} ${counts[k]}`);
    return parts.length ? `<div class="visit-product-counts">${parts.join(' · ')}</div>` : '';
  }

  function renderVisits(it) {
    const visits = it.visits || [];
    if (!visits.length) return '<span class="muted">无</span>';
    const head = `近 30 天访问明细（${visits.length} 条${it.visits_truncated ? '，仅显示最近 ' + visits.length + ' 条' : ''}）`;
    return `<div class="visit-detail-head">${esc(head)}</div><ul class="visit-list">` + visits.map(v => {
      const extra = [v.ip, v.page, v.referrer && ('来自 ' + v.referrer), v.source && ('src=' + v.source)]
        .filter(Boolean).map(esc).join(' · ');
      return `<li><span class="visit-ts">${esc(fmtTs(v.ts))}</span> <span class="product-badge p-${esc(v.product)}">${esc(productLabel(v.product))}</span>${extra ? ` <span class="muted">· ${extra}</span>` : ''}</li>`;
    }).join('') + '</ul>';
  }

  function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function fmtFreq(v) {
    return (typeof v === 'number' && isFinite(v)) ? v.toFixed(1) : '0.0';
  }

  function fmtTs(ts) {
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return String(ts);
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[<>&"]/g, c => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
    }[c]));
  }

  document.getElementById('refresh-btn').addEventListener('click', init);
  filterEl.addEventListener('change', init);
  init();
})();
