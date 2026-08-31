/* AI 信号台 —— 前端逻辑。
 *
 * 无依赖、无外部请求、无埋点。只做四件事：
 *   1. 读 data/news.json
 *   2. 维护 { 期次, 类型, 关键词 } 三个状态，并同步到 URL hash（可分享）
 *   3. 渲染信号流 / 空态 / 错误态
 *   4. 键盘操作
 *
 * 一条硬规则：页面上出现的每一段文字，要么是简报原文，要么是对原文的计数与
 * 时间换算。绝不在这里生成新的判断、评分或摘要。
 */
(function () {
  "use strict";

  var DATA_URL = "data/news.json";
  var ALL = "all";

  // 类型 -> 键盘键。顺序即筛选条顺序。
  var CATEGORY_KEYS = {
    "voices": "X",
    "leaderboards": "B",
    "tech-news": "N",
    "releases": "R"
  };

  var SESSION_HINT = {
    "早间": "09:00", "午间": "12:30", "收盘": "17:00", "晚间": "20:00"
  };

  var state = { brief: null, cat: ALL, q: "" };
  var data = null;
  var briefIndex = {};
  var searchDocs = [];

  var $ = function (id) { return document.getElementById(id); };

  // ── 工具 ────────────────────────────────────────────────

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function parseStamp(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDateTime(iso) {
    var d = parseStamp(iso);
    if (!d) return "—";
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
           " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtRelative(iso) {
    var d = parseStamp(iso);
    if (!d) return "—";
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 0) return "刚刚";
    if (mins < 60) return mins + " 分钟前";
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + " 小时前";
    var days = Math.round(hours / 24);
    if (days < 30) return days + " 天前";
    return Math.round(days / 30) + " 个月前";
  }

  /* 只把「本站可以打开的原文链接」渲染成 <a>。任何非 http(s) 的东西都不渲染，
     避免出现 javascript: 之类的协议。 */
  function safeUrl(url) {
    if (!url || typeof url !== "string") return null;
    return /^https?:\/\//i.test(url) ? url : null;
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (e) { return null; }
  }

  function highlight(text, terms) {
    var html = esc(text);
    if (!terms.length) return html;
    // 逐词包 <mark>：在已转义的字符串上做，避免注入。
    terms.forEach(function (term) {
      if (!term) return;
      var re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      html = html.replace(re, function (m) { return "<mark>" + m + "</mark>"; });
    });
    return html;
  }

  // ── URL 状态 ────────────────────────────────────────────

  function readHash() {
    var raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return {};
    var out = {};
    raw.split("&").forEach(function (pair) {
      var i = pair.indexOf("=");
      if (i < 0) return;
      try {
        out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      } catch (e) { /* 手改过的 hash，忽略 */ }
    });
    return out;
  }

  function writeHash(replace) {
    var parts = [];
    if (state.q) parts.push("q=" + encodeURIComponent(state.q));
    if (state.cat !== ALL) parts.push("cat=" + encodeURIComponent(state.cat));
    if (state.brief && data.briefs.length && state.brief !== data.briefs[0].id) {
      parts.push("brief=" + encodeURIComponent(state.brief));
    }
    var hash = parts.length ? "#" + parts.join("&") : location.pathname + location.search;
    if (replace) { history.replaceState(null, "", hash); }
    else { history.pushState(null, "", hash); }
  }

  function applyHash() {
    var h = readHash();
    state.q = h.q || "";
    state.cat = (h.cat && (h.cat === ALL || CATEGORY_KEYS[h.cat])) ? h.cat : ALL;
    state.brief = (h.brief && briefIndex[h.brief]) ? h.brief
                : (data.briefs.length ? data.briefs[0].id : null);
    $("search-input").value = state.q;
    $("brief-select").value = state.brief || "";
  }

  // ── 渲染：状态盘 ────────────────────────────────────────

  function renderConsole() {
    var latest = data.briefs[0];
    var current = briefIndex[state.brief] || latest;
    if (!current) return;

    $("console-stamp").textContent = "brief/" + current.id;
    $("stat-session").innerHTML = esc(current.session) +
      "<small>" + esc(SESSION_HINT[current.session] || "") + " 档</small>";
    $("stat-published").innerHTML = esc(fmtDateTime(current.generated_at)) +
      "<small>" + esc(current.date) + "</small>";
    $("stat-fresh").innerHTML = esc(fmtRelative(latest.generated_at)) +
      "<small>相对最新一期</small>";
    $("stat-items").innerHTML = current.item_count +
      "<small>本期条目</small>";
    $("stat-archive").innerHTML = data.brief_count +
      "<small>期 / " + data.item_count + " 条</small>";

    var degraded = !!current.degraded;
    $("stat-link").innerHTML = (degraded ? "部分异常" : "正常") +
      "<small>" + esc(current.origin === "cron" ? "归档自定时任务" : "实时并入") + "</small>";
    $("console-grid").previousElementSibling
      .querySelector(".console__dot")
      .setAttribute("data-state", degraded ? "warn" : "ok");

    var warn = $("console-warn");
    if (degraded && current.warnings && current.warnings.length) {
      warn.hidden = false;
      warn.textContent = "⚠ " + current.warnings.join(" / ");
    } else {
      warn.hidden = true;
      warn.textContent = "";
    }

    $("foot-meta").textContent =
      "归档 " + data.earliest_at.slice(0, 10) + " → " + data.latest_at.slice(0, 10) +
      " · " + data.brief_count + " 期 · " + data.item_count + " 条";
  }

  // ── 渲染：筛选条 ────────────────────────────────────────

  function renderFilters() {
    var wrap = $("filters");
    var counts = data.category_counts || {};
    var defs = [{ key: ALL, label: "全部", n: data.item_count, k: "A" }];

    (data.categories || []).forEach(function (cat) {
      if (!counts[cat.key]) return;           // 没有内容的类型不占位
      defs.push({ key: cat.key, label: cat.label, n: counts[cat.key], k: CATEGORY_KEYS[cat.key] });
    });

    wrap.innerHTML = defs.map(function (d) {
      return '<button type="button" class="chip" data-cat="' + esc(d.key) + '" ' +
             'aria-pressed="' + (state.cat === d.key) + '">' +
             (d.k ? "<kbd>" + esc(d.k) + "</kbd>" : "") +
             esc(d.label) + '<span class="chip__n">' + d.n + "</span></button>";
    }).join("");
  }

  function syncFilters() {
    Array.prototype.forEach.call($("filters").querySelectorAll(".chip"), function (btn) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-cat") === state.cat));
    });
  }

  function renderPicker() {
    $("brief-select").innerHTML = data.briefs.map(function (b, i) {
      return '<option value="' + esc(b.id) + '">' +
             esc(b.date + " · " + b.session + (i === 0 ? "（最新）" : "") +
                 " · " + b.item_count + " 条" + (b.degraded ? " ⚠" : "")) +
             "</option>";
    }).join("");
  }

  // ── 渲染：条目 ──────────────────────────────────────────

  function itemHTML(item, terms, fromBrief) {
    var url = safeUrl(item.url);
    var host = url ? hostOf(url) : null;
    var isPost = !!item.source_handle;
    // AIHOT 是第三条「发现」链路：条目本身仍然是第三方原文，AIHOT 只是把它
    // 找出来的地方。所以这里只加一个克制的来源标记 + 一个站内出处链接，
    // 不新增分类、不改变正文，也不展示 AIHOT 的评分或推荐理由。
    var isAihot = item.discovery_source === "aihot";
    var aihotUrl = isAihot ? safeUrl(item.aihot_url) : null;
    var originalUrl = isAihot ? safeUrl(item.original_url) : null;

    var meta = ['<span class="tag tag--cat">' + esc(item.category_label) + "</span>"];
    if (isAihot) meta.push('<span class="tag tag--aihot">AIHOT 发现</span>');
    if (item.source_time_text) meta.push("<span>" + esc(item.source_time_text) + "</span>");
    // P1_5_… 这类是抓取端的内部分组代号，对读者没有意义，不外显。
    if (item.source_list && !/^P\d/.test(item.source_list)) {
      meta.push("<span>" + esc(item.source_list) + "</span>");
    }
    if (item.group_label) meta.push('<span class="tag tag--group">' + esc(item.group_label) + "</span>");

    var titleText = isPost ? item.source_handle : item.title;
    var titleInner = '<span class="' + (isPost ? "handle" : "") + '">' +
                     highlight(titleText, terms) + "</span>";
    var title = url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + titleInner + "</a>"
      : titleInner;

    var body = item.summary
      ? '<p class="signal__body">' + highlight(item.summary, terms) + "</p>"
      : '<p class="signal__body signal__body--none">（本条简报未附摘要，请点原文链接查看）</p>';

    var foot = [];
    if (isAihot && (aihotUrl || originalUrl)) {
      // 两个链接都保留：AIHOT 是署名与出处，原文才是事实来源。
      if (aihotUrl) {
        foot.push('<a class="srclink srclink--aihot" href="' + esc(aihotUrl) +
                  '" target="_blank" rel="noopener noreferrer nofollow">AIHOT</a>');
      }
      if (originalUrl) {
        foot.push('<a class="srclink" href="' + esc(originalUrl) +
                  '" target="_blank" rel="noopener noreferrer">原文</a>');
      }
    } else if (url) {
      foot.push('<a class="srclink" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
                esc(host || "打开原文") + "</a>");
    }
    if (item.source_name) foot.push('<span class="srcfrom">来源 · ' + esc(item.source_name) + "</span>");
    if (fromBrief) {
      foot.push('<span class="signal__from">出自 <button type="button" data-goto="' +
                esc(fromBrief.id) + '">' + esc(fromBrief.date + " " + fromBrief.session) +
                "</button></span>");
    }

    return '<article class="signal" data-cat="' + esc(item.category) + '">' +
             '<div class="signal__rail" aria-hidden="true">' +
               '<span class="signal__node"></span>' +
               '<span class="signal__idx">' + String(item.index).padStart(2, "0") + "</span>" +
             "</div>" +
             "<div>" +
               '<div class="signal__meta">' + meta.join("") + "</div>" +
               '<h3 class="signal__title">' + title + "</h3>" +
               body +
               (foot.length ? '<div class="signal__foot">' + foot.join("") + "</div>" : "") +
             "</div>" +
           "</article>";
  }

  function groupHTML(label, items, terms, withSource) {
    return '<section class="group">' +
             '<div class="group__head">' +
               '<h3 class="group__label">' + esc(label) + "</h3>" +
               '<span class="group__n">' + items.length + " 条</span>" +
             "</div>" +
             '<div class="signals">' +
               items.map(function (entry) {
                 return itemHTML(entry.item, terms, withSource ? entry.brief : null);
               }).join("") +
             "</div>" +
           "</section>";
  }

  function stateHTML(kind, mono, text, action) {
    return '<div class="state state--' + kind + '">' +
             '<p class="state__mono">' + esc(mono) + "</p>" +
             "<p>" + esc(text) + "</p>" +
             (action ? '<div class="state__actions">' + action + "</div>" : "") +
           "</div>";
  }

  // ── 渲染：主流程 ────────────────────────────────────────

  function terms() {
    return state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function matches(doc, tokens) {
    for (var i = 0; i < tokens.length; i++) {
      if (doc.hay.indexOf(tokens[i]) < 0) return false;
    }
    return true;
  }

  function render() {
    var body = $("feed-body");
    var tokens = terms();
    var searching = tokens.length > 0;
    var entries;

    if (searching) {
      entries = searchDocs.filter(function (doc) { return matches(doc, tokens); });
    } else {
      var brief = briefIndex[state.brief];
      entries = brief ? brief.items.map(function (item) {
        return { item: item, brief: brief };
      }) : [];
    }

    if (state.cat !== ALL) {
      entries = entries.filter(function (e) { return e.item.category === state.cat; });
    }

    // 抬头
    if (searching) {
      $("feed-title").textContent = "检索结果";
      $("feed-sub").textContent = "SEARCH // 全部 " + data.brief_count + " 期归档 · 关键词「" + state.q.trim() + "」";
    } else {
      var b = briefIndex[state.brief];
      $("feed-title").textContent = b ? (b.date + " " + b.session + "简报") : "简报";
      $("feed-sub").textContent = b
        ? "BRIEF // " + b.id + " · 发布于 " + fmtDateTime(b.generated_at) + " · " + fmtRelative(b.generated_at)
        : "";
    }

    $("result-note").textContent = entries.length
      ? (searching ? "命中 " + entries.length + " 条" : "显示 " + entries.length + " 条")
      : "无结果";

    // 空态
    if (!entries.length) {
      body.innerHTML = stateHTML(
        "empty", "NO SIGNAL",
        searching
          ? "没有匹配「" + state.q.trim() + "」的内容。换个关键词，或清除筛选后再试。"
          : "这一期在当前筛选下没有内容。切换类型或选择其他期次。",
        '<button type="button" class="state__btn" data-reset="1">清除筛选与检索</button>'
      );
      return;
    }

    // 降级提示：只在看单期、且这期确实标了「部分链路异常」时出现
    var head = "";
    var current = briefIndex[state.brief];
    if (!searching && current && current.degraded) {
      head = '<div class="notice"><span class="notice__mono">DEGRADED</span><span>' +
             "这一期在生成时有链路异常：" + esc((current.warnings || []).join(" / ")) +
             "。下面是当时仍然抓到并推送出去的部分。</span></div>";
    }

    // 分组：按类型聚合，保持 categories 定义的顺序
    var order = (data.categories || []).map(function (c) { return c.key; });
    var buckets = {};
    entries.forEach(function (e) {
      (buckets[e.item.category] = buckets[e.item.category] || []).push(e);
    });

    body.innerHTML = head + order.filter(function (key) {
      return buckets[key] && buckets[key].length;
    }).map(function (key) {
      var label = (data.categories.filter(function (c) { return c.key === key; })[0] || {}).label || key;
      return groupHTML(label, buckets[key], tokens, searching);
    }).join("");
  }

  function refresh(push) {
    renderConsole();
    syncFilters();
    render();
    writeHash(!push);
  }

  // ── 交互 ────────────────────────────────────────────────

  function setCat(cat, push) {
    state.cat = cat;
    refresh(push);
  }

  function setBrief(id, push) {
    if (!briefIndex[id]) return;
    state.brief = id;
    state.q = "";
    $("search-input").value = "";
    $("search-clear").hidden = true;
    $("brief-select").value = id;
    refresh(push);
  }

  var searchTimer = null;
  function onSearchInput() {
    var value = $("search-input").value;
    $("search-clear").hidden = !value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.q = value;
      refresh(false);
    }, 120);
  }

  function resetAll() {
    state.q = "";
    state.cat = ALL;
    state.brief = data.briefs.length ? data.briefs[0].id : null;
    $("search-input").value = "";
    $("search-clear").hidden = true;
    $("brief-select").value = state.brief || "";
    refresh(true);
  }

  function copyLink() {
    var btn = $("copy-link");
    var url = location.href;
    var done = function (ok) {
      btn.setAttribute("data-done", ok ? "1" : "0");
      btn.textContent = ok ? "✓ 链接已复制" : "复制失败，请手动复制地址栏";
      setTimeout(function () {
        btn.removeAttribute("data-done");
        btn.innerHTML = '<kbd aria-hidden="true">S</kbd> 复制当前视图链接';
      }, 2200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); },
                                              function () { done(false); });
    } else {
      done(false);
    }
  }

  var lastFocus = null;
  function toggleSheet(open) {
    var sheet = $("shortcuts");
    if (open) {
      lastFocus = document.activeElement;
      sheet.hidden = false;
      $("shortcuts-close").focus();
    } else {
      sheet.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
  }

  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function bind() {
    $("filters").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cat]");
      if (btn) setCat(btn.getAttribute("data-cat"), true);
    });

    $("feed-body").addEventListener("click", function (e) {
      var goto = e.target.closest("[data-goto]");
      if (goto) { setBrief(goto.getAttribute("data-goto"), true); return; }
      if (e.target.closest("[data-reset]")) resetAll();
    });

    $("brief-select").addEventListener("change", function (e) {
      setBrief(e.target.value, true);
    });

    $("search-input").addEventListener("input", onSearchInput);
    $("search-clear").addEventListener("click", function () {
      $("search-input").value = "";
      $("search-clear").hidden = true;
      state.q = "";
      refresh(true);
      $("search-input").focus();
    });

    $("copy-link").addEventListener("click", copyLink);
    $("shortcuts-close").addEventListener("click", function () { toggleSheet(false); });
    $("shortcuts").addEventListener("click", function (e) {
      if (e.target === $("shortcuts")) toggleSheet(false);
    });

    document.querySelector(".masthead__nav").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-nav]");
      if (!btn) return;
      var nav = btn.getAttribute("data-nav");
      if (nav === "latest") { resetAll(); $("feed").scrollIntoView({ block: "start" }); }
      else if (nav === "archive") { $("brief-select").focus(); }
      else if (nav === "shortcuts") { toggleSheet(true); }
      else { setCat(nav, true); $("feed").scrollIntoView({ block: "start" }); }
    });

    window.addEventListener("hashchange", function () {
      applyHash();
      renderConsole(); syncFilters(); render();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!$("shortcuts").hidden) { toggleSheet(false); return; }
        if (state.q) { $("search-input").value = ""; state.q = ""; $("search-clear").hidden = true; refresh(true); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;

      if (e.key === "/") { e.preventDefault(); $("search-input").focus(); $("search-input").select(); return; }
      if (e.key === "?") { e.preventDefault(); toggleSheet(true); return; }

      var key = e.key.toUpperCase();
      if (key === "A") { setCat(ALL, true); return; }
      if (key === "L") { resetAll(); return; }
      if (key === "H") { $("brief-select").focus(); return; }
      if (key === "S") { copyLink(); return; }
      for (var cat in CATEGORY_KEYS) {
        if (CATEGORY_KEYS[cat] === key && (data.category_counts || {})[cat]) {
          setCat(cat, true);
          return;
        }
      }
    });
  }

  // ── 启动 ────────────────────────────────────────────────

  function buildIndex() {
    briefIndex = {};
    searchDocs = [];
    data.briefs.forEach(function (brief) {
      briefIndex[brief.id] = brief;
      brief.items.forEach(function (item) {
        searchDocs.push({
          item: item,
          brief: brief,
          hay: [item.title, item.summary, item.source_name, item.source_handle,
                item.category_label, item.group_label, brief.session, brief.date]
               .filter(Boolean).join(" ").toLowerCase()
        });
      });
    });
  }

  function fail(message) {
    $("feed-body").innerHTML = stateHTML(
      "error", "ERROR // news.json", message,
      '<button type="button" class="state__btn" onclick="location.reload()">重新载入</button>'
    );
    $("feed-title").textContent = "暂时读不到简报";
    $("result-note").textContent = "载入失败";
  }

  function start(payload) {
    data = payload;
    if (!data || !Array.isArray(data.briefs)) { fail("简报数据格式不正确。"); return; }
    if (!data.briefs.length) {
      $("feed-title").textContent = "还没有简报";
      $("feed-body").innerHTML = stateHTML("empty", "NO ARCHIVE",
        "归档里还没有任何简报。下一次定时任务成功推送后，这里会自动出现。");
      $("result-note").textContent = "0 条";
      return;
    }
    buildIndex();
    renderFilters();
    renderPicker();
    applyHash();
    renderConsole();
    syncFilters();
    render();
    bind();
  }

  fetch(DATA_URL, { cache: "no-cache" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(start)
    .catch(function (err) {
      fail("载入简报数据失败（" + err.message + "）。如果是本地直接打开的 HTML 文件，请改用静态服务器访问。");
    });
})();
