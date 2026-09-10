// 准入门槛：提交表单 -> submit_form 拿 token -> verify_token 校验 -> 展示看板
// 与 briefs / token-gpu 共用同一套 submissions/token 体系（同源 localStorage barry_token），
// 存取与云函数调用统一走共享适配器 BarryAccess（js/barry-access.js），本页只负责界面状态。
(function () {
  const A = window.BarryAccess;
  const PRODUCT = 'openrouter';

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

  // 校验通过后：展示看板，记录一次 product=openrouter 的访问（30 分钟窗口去重，失败不阻塞），
  // 再广播 barry:unlocked 让 dashboard.js 开始加载数据。
  function revealDashboard(name) {
    loadingEl.hidden = true;
    formEl.hidden = true;
    gateSection.hidden = true;
    dashboardSection.hidden = false;
    viewerNameEl.textContent = name || A.getName() || '';
    if (window.cbReady) A.logVisit(window.cbReady, PRODUCT);
    window.dispatchEvent(new CustomEvent(A.UNLOCK_EVENT));
  }

  async function verifyAndReveal(token) {
    showLoading();
    try {
      const cb = await window.cbReady;
      const r = await A.verify(cb, token);
      if (r.valid) {
        revealDashboard(r.name);
      } else {
        // 后端明确说无效才清身份；网络失败走 catch，保留 token 让用户刷新重试
        A.clearIdentity();
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

    const fields = {
      name: document.getElementById('f-name').value,
      org: document.getElementById('f-org').value,
      contact: document.getElementById('f-contact').value,
      msg: document.getElementById('f-msg').value,
    };

    const check = A.validateForm(fields);
    if (!check.ok) {
      showFormErr(check.error);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';

    try {
      const cb = await window.cbReady;
      const r = await A.submit(cb, fields, PRODUCT);   // 成功即写入 barry_token / barry_name
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
    A.clearIdentity();
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

    const existingToken = A.getToken();
    if (existingToken) {
      verifyAndReveal(existingToken);
    } else {
      showGateForm();
    }
  }
})();
