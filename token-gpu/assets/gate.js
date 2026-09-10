// 访问闸门：提交表单 -> submit_form 拿 token -> verify_token 校验 -> 展开完整看板
// 与 briefs / openrouter 共用同一套 submissions/token 体系（同源 localStorage barry_token），
// 存取与云函数调用统一走共享适配器 BarryAccess（assets/barry-access.js），本文件只管界面状态。
// 数据分区默认带 hidden + data-gated；校验通过后去掉 hidden 并广播 barry:unlocked，
// app.js 收到事件（或看到 html[data-barry-unlocked]）后再渲染完整图表。
(function () {
  'use strict';
  var A = window.BarryAccess;
  var PRODUCT = 'token-gpu';

  var section = document.getElementById('access');
  if (!section) return;

  var loadingEl = document.getElementById('access-loading');
  var formEl = document.getElementById('access-form');
  var errEl = document.getElementById('access-err');
  var initErrEl = document.getElementById('access-init-error');
  var submitBtn = document.getElementById('access-submit');
  var unlockedEl = document.getElementById('access-unlocked');
  var viewerNameEl = document.getElementById('viewer-name');
  var resetLink = document.getElementById('reset-access');
  var gatedNodes = Array.prototype.slice.call(document.querySelectorAll('[data-gated]'));

  function showFormErr(msg) { errEl.textContent = msg; errEl.hidden = false; }
  function hideFormErr() { errEl.hidden = true; }
  function showInitErr(msg) { initErrEl.textContent = msg; initErrEl.hidden = false; }
  function hideInitErr() { initErrEl.hidden = true; }

  function showForm() {
    loadingEl.hidden = true;
    formEl.hidden = false;
    unlockedEl.hidden = true;
  }
  function showLoading() {
    formEl.hidden = true;
    loadingEl.hidden = false;
  }

  // 适配器没加载（脚本 404 / 被拦截）时页面不能成死页：表单照常显示，只是提交会给出明确错误。
  if (!A) {
    showInitErr('访问组件加载失败，请刷新重试；若持续失败请检查网络或浏览器扩展。');
    showForm();
    formEl.addEventListener('submit', function (e) {
      e.preventDefault();
      showFormErr('访问组件未就绪，暂时无法提交，请刷新页面后重试。');
    });
    return;
  }

  // 校验通过后：展开数据分区，记录一次 product=token-gpu 的访问（30 分钟窗口去重，失败不阻塞），
  // 再广播 barry:unlocked 让 app.js 渲染完整图表。
  function reveal(name) {
    loadingEl.hidden = true;
    formEl.hidden = true;
    viewerNameEl.textContent = name || A.getName() || '';
    unlockedEl.hidden = false;
    gatedNodes.forEach(function (node) { node.hidden = false; });
    document.documentElement.setAttribute('data-barry-unlocked', '1');
    if (window.cbReady) A.logVisit(window.cbReady, PRODUCT);
    window.dispatchEvent(new CustomEvent(A.UNLOCK_EVENT));
  }

  function verifyAndReveal(token) {
    showLoading();
    return window.cbReady
      .then(function (cb) { return A.verify(cb, token); })
      .then(function (r) {
        if (r.valid) {
          reveal(r.name);
        } else {
          // 后端明确说无效才清身份；网络失败走 catch，保留 token 让用户刷新重试
          A.clearIdentity();
          showForm();
        }
      })
      .catch(function (e) {
        showInitErr('访问验证失败，请检查网络后刷新重试：' + (e && e.message ? e.message : e));
        showForm();
      });
  }

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    hideFormErr();
    hideInitErr();

    var fields = {
      name: document.getElementById('f-name').value,
      org: document.getElementById('f-org').value,
      contact: document.getElementById('f-contact').value,
      msg: document.getElementById('f-msg').value,
    };
    var check = A.validateForm(fields);
    if (!check.ok) { showFormErr(check.error); return; }
    if (!window.cbReady) { showFormErr('访问服务未就绪，请刷新页面后重试。'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';
    window.cbReady
      .then(function (cb) { return A.submit(cb, fields, PRODUCT); })   // 成功即写入 barry_token / barry_name
      .then(function (r) { return verifyAndReveal(r.token); })
      .catch(function (err) { showFormErr('提交失败：' + (err && err.message ? err.message : err)); })
      .then(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = '解锁完整看板';
      });
  });

  resetLink.addEventListener('click', function (e) {
    e.preventDefault();
    A.clearIdentity();
    location.hash = '';
    location.reload();
  });

  if (!window.cbReady) {
    showInitErr('CloudBase SDK 加载失败，请检查网络后刷新重试。');
    showForm();
    return;
  }
  window.cbReady.catch(function (e) {
    showInitErr('访问服务初始化失败，请检查网络后刷新重试：' + (e && e.message ? e.message : e));
    showForm();
  });

  var existingToken = A.getToken();
  if (existingToken) {
    verifyAndReveal(existingToken);
  } else {
    showForm();
  }
})();
