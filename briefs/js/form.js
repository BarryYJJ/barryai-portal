// Form 提交：写入 submissions 表，存 token + name，跳 viewer
(function () {
  // 已填过？直接跳 viewer
  if (localStorage.getItem('barry_token')) {
    location.href = './viewer.html';
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

    const data = {
      name:    document.getElementById('f-name').value.trim(),
      org:     document.getElementById('f-org').value.trim(),
      contact: document.getElementById('f-contact').value.trim(),
      msg:     document.getElementById('f-msg').value.trim(),
    };

    if (!data.name || !data.org || !data.contact) {
      showErr('请把姓名、机构、联系方式填完');
      return;
    }
    if (data.contact.length < 5) {
      showErr('联系方式看起来不太对，再确认一下');
      return;
    }

    btn.disabled = true;
    btn.textContent = '提交中…';

    try {
      const cb = await window.cbReady;
      const res = await cb.callFunction({
        name: 'submit_form',
        data,
      });

      const r = res.result || {};
      if (r.error) throw new Error(r.error);
      if (!r.token) throw new Error('未收到 token，请重试');

      localStorage.setItem('barry_token', r.token);
      localStorage.setItem('barry_name',  data.name);

      // 跳到 viewer
      location.href = './viewer.html';
    } catch (err) {
      showErr('提交失败：' + (err.message || err));
      btn.disabled = false;
      btn.textContent = '解锁今日简报';
    }
  });
})();
