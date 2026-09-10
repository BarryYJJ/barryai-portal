// Barry 访客系统共享适配器（briefs / openrouter / token-gpu 三个仓库各放一份，
// 内容必须逐字一致：常量、localStorage 键名、云函数名与字段名就是三方共用的契约）。
//
// 身份：同源 localStorage barry_token / barry_name。三个产品都挂在同一域名的
//       /briefs/ /openrouter/ /token-gpu/ 子路径下，所以填过一次表即三处通用。
// 后端：briefs 仓库 website/functions 里的 submit_form / verify_token / log_visit。
// 访问记录：每次通过校验进入产品都调 log_visit，带显式 product 与来源元数据；
//       同一产品 30 分钟内只记一次（前端 localStorage 时间戳 + 后端同窗口去重）。
//
// 这是线索收集，不是安全付费墙：静态 JSON 与简报 HTML 本身仍是公开可访问的。
(function (root) {
  'use strict';

  var TOKEN_KEY = 'barry_token';
  var NAME_KEY = 'barry_name';
  var VISIT_STAMP_PREFIX = 'barry_visit_';        // barry_visit_<product> = 上次成功记录访问的毫秒时间戳
  var VISIT_WINDOW_MS = 30 * 60 * 1000;            // 同一产品 30 分钟内不重复记录
  var DEFAULT_PRODUCT = 'briefs';                  // 旧记录 / 无法识别路径时的回落产品
  var PRODUCTS = {
    briefs: { id: 'briefs', label: '今天在涨啥', path: '/briefs/' },
    openrouter: { id: 'openrouter', label: 'OpenRouter 数据看板', path: '/openrouter/' },
    'token-gpu': { id: 'token-gpu', label: 'Token & GPU 数据看板', path: '/token-gpu/' },
  };
  var PRODUCT_IDS = ['briefs', 'openrouter', 'token-gpu'];

  // ---------- 存储（localStorage 不可用时退化为内存，不抛错） ----------
  var memory = {};
  function storage() {
    try {
      var ls = root.localStorage;
      if (ls) {
        var probe = '__barry_probe__';
        ls.setItem(probe, '1');
        ls.removeItem(probe);
        return ls;
      }
    } catch (e) { /* 隐私模式 / 被禁用 */ }
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
      setItem: function (k, v) { memory[k] = String(v); },
      removeItem: function (k) { delete memory[k]; },
    };
  }

  // ---------- 产品识别 ----------
  function normalizeProduct(value) {
    var v = (value == null ? '' : String(value)).trim().toLowerCase();
    if (v === 'token_gpu' || v === 'tokengpu') v = 'token-gpu';
    return PRODUCTS[v] ? v : '';
  }

  function productFromPath(pathname) {
    var p = (pathname == null ? '' : String(pathname)).toLowerCase();
    for (var i = 0; i < PRODUCT_IDS.length; i++) {
      var id = PRODUCT_IDS[i];
      var prefix = PRODUCTS[id].path;
      if (p === prefix.slice(0, -1) || p.indexOf(prefix) === 0) return id;
    }
    return '';
  }

  function resolveProduct(explicit, pathname) {
    return normalizeProduct(explicit) || productFromPath(pathname) || DEFAULT_PRODUCT;
  }

  // ---------- 身份 ----------
  function getToken() { return (storage().getItem(TOKEN_KEY) || '').trim(); }
  function getName() { return storage().getItem(NAME_KEY) || ''; }
  function saveIdentity(token, name) {
    var s = storage();
    s.setItem(TOKEN_KEY, String(token));
    if (name) s.setItem(NAME_KEY, String(name));
  }
  function clearIdentity() {
    var s = storage();
    s.removeItem(TOKEN_KEY);
    s.removeItem(NAME_KEY);
    for (var i = 0; i < PRODUCT_IDS.length; i++) s.removeItem(VISIT_STAMP_PREFIX + PRODUCT_IDS[i]);
  }

  // ---------- 表单校验（与 submit_form 云函数口径一致） ----------
  function clean(v, max) { return (v == null ? '' : String(v)).trim().slice(0, max); }
  function validateForm(fields) {
    fields = fields || {};
    var data = {
      name: clean(fields.name, 50),
      org: clean(fields.org, 100),
      contact: clean(fields.contact, 80),
      msg: clean(fields.msg, 500),
    };
    if (!data.name || !data.org || !data.contact) {
      return { ok: false, error: '请把姓名、机构、联系方式填完', data: data };
    }
    if (data.contact.length < 5) {
      return { ok: false, error: '联系方式看起来不太对，再确认一下', data: data };
    }
    return { ok: true, error: '', data: data };
  }

  // ---------- 来源元数据（只取路径 / 来源站点，不含敏感信息） ----------
  function refererHost(ref) {
    if (!ref) return '';
    var m = String(ref).match(/^[a-z]+:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function sourceParam(search) {
    var s = String(search || '');
    var m = s.match(/[?&](?:from|src|utm_source)=([^&#]*)/i);
    if (!m) return '';
    try { return decodeURIComponent(m[1]).slice(0, 60); } catch (e) { return m[1].slice(0, 60); }
  }
  function sourceMeta(product, env) {
    env = env || {};
    var loc = env.location || root.location || {};
    var pathname = loc.pathname || '';
    var pid = resolveProduct(product, pathname);
    return {
      product: pid,
      page: String(pathname || PRODUCTS[pid].path).slice(0, 100),
      referrer: refererHost(env.referrer != null ? env.referrer : (root.document && root.document.referrer)).slice(0, 120),
      source: sourceParam(loc.search),
      ua: String(env.ua != null ? env.ua : (root.navigator && root.navigator.userAgent) || '').slice(0, 300),
    };
  }

  // ---------- 访问去重窗口 ----------
  function shouldLogVisit(product, now) {
    var pid = resolveProduct(product);
    var raw = storage().getItem(VISIT_STAMP_PREFIX + pid);
    var last = raw ? Number(raw) : 0;
    var t = now == null ? Date.now() : now;
    return !(last > 0 && t - last < VISIT_WINDOW_MS);
  }
  function markVisit(product, now) {
    var pid = resolveProduct(product);
    storage().setItem(VISIT_STAMP_PREFIX + pid, String(now == null ? Date.now() : now));
  }

  // ---------- 云函数调用 ----------
  function callFn(cb, name, data) {
    return cb.callFunction({ name: name, data: data }).then(function (res) {
      return (res && res.result) || {};
    });
  }

  // 提交表单：成功后写入身份并返回 { token, name }
  function submit(cb, fields, product) {
    var check = validateForm(fields);
    if (!check.ok) return Promise.reject(new Error(check.error));
    var meta = sourceMeta(product);
    var payload = {
      name: check.data.name, org: check.data.org, contact: check.data.contact, msg: check.data.msg,
      product: meta.product, page: meta.page, referrer: meta.referrer, source: meta.source,
    };
    return callFn(cb, 'submit_form', payload).then(function (r) {
      if (r.error) throw new Error(r.error);
      if (!r.token) throw new Error('未收到 token，请重试');
      saveIdentity(r.token, check.data.name);
      return { token: r.token, name: check.data.name };
    });
  }

  // 校验 token：返回 { valid, name }；网络失败向上抛出，由页面决定是否放行
  function verify(cb, token) {
    var t = (token == null ? getToken() : String(token)).trim();
    if (!t) return Promise.resolve({ valid: false, name: '' });
    return callFn(cb, 'verify_token', { token: t }).then(function (r) {
      return { valid: !!r.valid, name: r.name || '' };
    });
  }

  // 记录访问：受 30 分钟窗口约束；任何失败都吞掉，绝不阻塞页面
  function logVisit(cb, product, opts) {
    opts = opts || {};
    var pid = resolveProduct(product);
    var token = opts.token != null ? String(opts.token) : getToken();
    if (!token) return Promise.resolve({ logged: false, reason: 'no-token' });
    if (!opts.force && !shouldLogVisit(pid, opts.now)) {
      return Promise.resolve({ logged: false, reason: 'window' });
    }
    var meta = sourceMeta(pid);
    var payload = {
      token: token, product: meta.product, page: meta.page,
      referrer: meta.referrer, source: meta.source, ua: meta.ua,
    };
    return Promise.resolve(cb).then(function (client) {
      return callFn(client, 'log_visit', payload);
    }).then(function (r) {
      if (r && r.ok) {
        markVisit(pid, opts.now);
        return { logged: !r.deduped, reason: r.deduped ? 'server-window' : 'ok' };
      }
      return { logged: false, reason: (r && r.error) || 'rejected' };
    }).catch(function (e) {
      return { logged: false, reason: 'error', error: e };
    });
  }

  var api = {
    TOKEN_KEY: TOKEN_KEY,
    NAME_KEY: NAME_KEY,
    VISIT_STAMP_PREFIX: VISIT_STAMP_PREFIX,
    VISIT_WINDOW_MS: VISIT_WINDOW_MS,
    DEFAULT_PRODUCT: DEFAULT_PRODUCT,
    PRODUCTS: PRODUCTS,
    PRODUCT_IDS: PRODUCT_IDS,
    UNLOCK_EVENT: 'barry:unlocked',
    normalizeProduct: normalizeProduct,
    productFromPath: productFromPath,
    resolveProduct: resolveProduct,
    getToken: getToken,
    getName: getName,
    saveIdentity: saveIdentity,
    clearIdentity: clearIdentity,
    validateForm: validateForm,
    sourceMeta: sourceMeta,
    shouldLogVisit: shouldLogVisit,
    markVisit: markVisit,
    submit: submit,
    verify: verify,
    logVisit: logVisit,
  };

  root.BarryAccess = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
