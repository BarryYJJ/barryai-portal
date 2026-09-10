// Form 提交：通过共享适配器 BarryAccess 写入 submissions 表（product=briefs），
// 存 barry_token + barry_name，跳 viewer。三个看板共用同一 token，填过一次即通行。
(function () {
  const A = window.BarryAccess;
  const PRODUCT = 'briefs';

  // 已填过（在任一看板填过都算）？直接跳 viewer，由 viewer 校验 token
  if (A.getToken()) {
    location.href = '/briefs/viewer.html';
    return;
  }

  const form = document.getElementById('gate-form');
  const btn = document.getElementById('submit-btn');
  const errEl = document.getElementById('err-msg');

  function showErr(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function hideErr() {
    errEl.hidden = true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideErr();

    const fields = {
      name:    document.getElementById('f-name').value,
      org:     document.getElementById('f-org').value,
      contact: document.getElementById('f-contact').value,
      msg:     document.getElementById('f-msg').value,
    };

    const check = A.validateForm(fields);
    if (!check.ok) {
      showErr(check.error);
      return;
    }

    btn.disabled = true;
    btn.textContent = '提交中…';

    try {
      const cb = await window.cbReady;
      await A.submit(cb, fields, PRODUCT);   // 成功即写入 localStorage barry_token / barry_name
      // 刚提交完立刻进入，算作一次访问（viewer 会带 product=briefs 记录）
      location.href = '/briefs/viewer.html';
    } catch (err) {
      showErr('提交失败：' + (err.message || err));
      btn.disabled = false;
      btn.textContent = '解锁今日简报';
    }
  });
})();
