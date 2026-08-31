// 准入门槛：提交表单 -> submit_form 拿 token -> verify_token 校验 -> 展示看板
// 与 briefs 站点用同一套 submissions/token 体系，但把 gate 与 viewer 合并在同一页里。
(function () {
  const TOKEN_KEY = 'barry_token';
  const NAME_KEY = 'barry_name';

  const gateSection = document.getElementById('gate-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const loadingEl = document.getElementById('gate-loading');
  const formEl = document.getElementById('gate-form');
  const errEl = document.getElementById('gate-err');
  const initErrEl = document.getElementById('gate-init-error');
  const submitBtn = document.getElementById('gate-submit-btn');
  const viewerNameEl = document.getElementById('viewer-name');
  const resetLink = document.getElementById('reset-access');

  function showFormErr(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function hideFormErr() {
    errEl.hidden = true;
  }
  function showInitErr(msg) {
    initErrEl.textContent = msg;
    initErrEl.hidden = false;
  }
  function hideInitErr() {
    initErrEl.hidden = true;
  }

  function showGateForm() {
    loadingEl.hidden = true;
    formEl.hidden = false;
    dashboardSection.hidden = true;
    gateSection.hidden = false;
  }

  function showLoading() {
    formEl.hidden = true;
    loadingEl.hidden = false;
  }

  function logVisitNonBlocking(token) {
    if (!window.cbReady) return;
    window.cbReady
      .then((cb) => cb.callFunction({
        name: 'log_visit',
        data: { token, page: location.pathname, ua: navigator.userAgent },
      }))
      .catch(() => {});
  }

  function revealDashboard(name) {
    loadingEl.hidden = true;
    formEl.hidden = true;
    gateSection.hidden = true;
    dashboardSection.hidden = false;
    viewerNameEl.textContent = name || localStorage.getItem(NAME_KEY) || '';
    logVisitNonBlocking(localStorage.getItem(TOKEN_KEY));
    window.dispatchEvent(new CustomEvent('barry:unlocked'));
  }

  async function verifyAndReveal(token) {
    showLoading();
    try {
      const cb = await window.cbReady;
      const res = await cb.callFunction({ name: 'verify_token', data: { token } });
      const r = res.result || {};
      if (r.valid) {
        revealDashboard(r.name);
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(NAME_KEY);
        showGateForm();
      }
    } catch (e) {
      showInitErr('访问验证失败，请检查网络后刷新重试：' + (e.message || e));
      showGateForm();
    }
  }

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideFormErr();
    hideInitErr();

    const data = {
      name: document.getElementById('f-name').value.trim(),
      org: document.getElementById('f-org').value.trim(),
      contact: document.getElementById('f-contact').value.trim(),
      msg: document.getElementById('f-msg').value.trim(),
    };

    if (!data.name || !data.org || !data.contact) {
      showFormErr('请把姓名、机构、联系方式填完');
      return;
    }
    if (data.contact.length < 5) {
      showFormErr('联系方式看起来不太对，再确认一下');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';

    try {
      const cb = await window.cbReady;
      const res = await cb.callFunction({ name: 'submit_form', data });
      const r = res.result || {};
      if (r.error) throw new Error(r.error);
      if (!r.token) throw new Error('未收到 token，请重试');

      localStorage.setItem(TOKEN_KEY, r.token);
      localStorage.setItem(NAME_KEY, data.name);

      await verifyAndReveal(r.token);
    } catch (err) {
      showFormErr('提交失败：' + (err.message || err));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '解锁看板';
    }
  });

  resetLink.addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
    location.hash = '';
    location.reload();
  });

  if (!window.cbReady) {
    showInitErr('CloudBase SDK 加载失败，请检查网络后刷新重试。');
    showGateForm();
  } else {
    window.cbReady.catch((e) => {
      showInitErr('访问服务初始化失败，请检查网络后刷新重试：' + (e.message || e));
      showGateForm();
    });

    const existingToken = localStorage.getItem(TOKEN_KEY);
    if (existingToken) {
      verifyAndReveal(existingToken);
    } else {
      showGateForm();
    }
  }
})();
