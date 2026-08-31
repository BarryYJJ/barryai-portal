// Admin：URL 带 ?key=xxx 才能进，从云函数拉提交列表 + 近 7 天访问明细
(function () {
  const KEY = new URLSearchParams(location.search).get('key');
  const loadingEl = document.getElementById('loading');
  const authEl    = document.getElementById('auth-prompt');
  const tableEl   = document.getElementById('visitors-table');
  const bodyEl    = document.getElementById('visitors-body');

  if (!KEY) {
    loadingEl.hidden = true;
    authEl.hidden = false;
    return;
  }

  async function init() {
    loadingEl.hidden = false;
    loadingEl.textContent = '加载中…';
    authEl.hidden = true;
    tableEl.hidden = true;

    try {
      const cb = await window.cbReady;
      const res = await cb.callFunction({
        name: 'admin_list',
        data: { admin_key: KEY },
      });
      const r = res.result || {};
      if (r.error) {
        loadingEl.textContent = '认证失败：' + r.error;
        return;
      }
      render(r.items || [], r.total_visits_week || 0);
    } catch (e) {
      loadingEl.textContent = '加载错误：' + (e.message || e);
    }
  }

  function render(items, totalVisitsWeek) {
    loadingEl.hidden = true;
    tableEl.hidden = false;

    // 统计
    document.getElementById('stat-total').textContent = items.length;
    const now = new Date();
    const todayStr = localDateKey(now);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const today = items.filter(x => localDateKey(new Date(x.ts)) === todayStr).length;
    const week  = items.filter(x => new Date(x.ts) > weekAgo).length;
    document.getElementById('stat-today').textContent = today;
    document.getElementById('stat-week').textContent  = week;
    document.getElementById('stat-visits-week').textContent = totalVisitsWeek;

    // 表格
    const html = items.length ? items.map((it, idx) => {
      const ts = fmtTs(it.ts);
      const count = it.visit_count || 0;
      const hasVisits = count > 0;
      const visitsHtml = hasVisits ? renderVisits(it.visits) : '';
      const toggleBtn = hasVisits
        ? `<button class="visit-toggle" data-row="${idx}">${count} 次 <span class="caret">▾</span></button>`
        : `<span class="visit-zero">0 次</span>`;

      return `
        <tr>
          <td class="ts">${esc(ts)}</td>
          <td>${esc(it.name)}</td>
          <td>${esc(it.org)}</td>
          <td>${esc(it.contact)}</td>
          <td class="muted">${esc(it.msg || '—')}</td>
          <td class="muted">${esc(it.ip || '—')}</td>
          <td class="visit-cell">${toggleBtn}</td>
        </tr>
        <tr class="visit-detail-row" id="vd-${idx}" hidden>
          <td colspan="7" class="visit-detail-cell">${visitsHtml}</td>
        </tr>
      `;
    }).join('') : `<tr><td colspan="7" class="muted" style="text-align:center;padding:30px;">还没人填过表</td></tr>`;
    bodyEl.innerHTML = html;

    // 绑定折叠按钮
    bodyEl.querySelectorAll('.visit-toggle').forEach(btn => {
      btn.onclick = () => {
        const row = document.getElementById('vd-' + btn.dataset.row);
        const isOpen = !row.hidden;
        row.hidden = isOpen;
        btn.querySelector('.caret').textContent = isOpen ? '▾' : '▴';
        btn.classList.toggle('open', !isOpen);
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

  function renderVisits(visits) {
    if (!visits || !visits.length) return '<span class="muted">无</span>';
    return '<div class="visit-detail-head">近 7 天访问明细</div><ul class="visit-list">' + visits.map(v => {
      const t = fmtTs(v.ts);
      const ipStr = v.ip ? ` <span class="muted">· ${esc(v.ip)}</span>` : '';
      return `<li><span class="visit-ts">${esc(t)}</span>${ipStr}</li>`;
    }).join('') + '</ul>';
  }

  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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
  init();
})();
