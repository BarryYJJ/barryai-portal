/* website/public/agent/app.js
 *
 * 小八 · AI 研究工作台 —— 前端逻辑。零依赖，纯浏览器原生 API。
 *
 * 安全约定（改动时请一并核对 tests/test_agent_console.py）：
 *   1. **主口令**（Hermes API_SERVER_KEY）只活在闸门提交那一瞬间的局部变量里：
 *      POST 给 /v1/console/auth/login 换成设备令牌，响应一到立刻丢弃，不进任何存储；
 *   2. **设备令牌**（服务端签发、可撤销、有到期）才进 localStorage —— 这样关标签页、
 *      重启浏览器之后工作台仍是激活的；两者都只以 `Authorization: Bearer …` 发出，
 *      不进 URL / DOM / 日志；
 *   3. 一切模型输出、工具预览、历史会话预览都用 textContent 渲染，绝不 innerHTML；
 *   4. 401 一律视为设备令牌失效：清令牌 → 回到闸门。**绝不删服务端历史**；
 *   5. 会话历史的真相是 Hermes 的 SessionDB；本地那份只是运行时视图，
 *      有条数与字符双重上限，且不含工具输出。
 */
(function (global) {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════
     第一部分：纯函数。不碰 DOM，可在 node 下直接 require 做单测。
     ═══════════════════════════════════════════════════════════════ */

  /**
   * 把一个 SSE 帧（\n\n 之间的文本块）解析成事件对象。
   * 只认 `data:` 与 `event:` 字段；以 `:` 开头的注释（keepalive）被忽略。
   * 返回 null 表示这一帧没有可用负载。
   */
  var DEFAULT_MAX_SSE_FRAME_CHARS = 256 * 1024;
  var DEFAULT_MAX_OUTPUT_CHARS = 1024 * 1024;

  function sseError(code, message) {
    var err = new Error(message);
    err.name = 'SseParseError';
    err.code = code;
    return err;
  }

  function parseSseFrame(frame) {
    var lines = String(frame == null ? '' : frame).split(/\r\n|\r|\n/);
    var dataLines = [];
    var eventName = '';

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.charAt(0) === ':') continue; // `: keepalive` / `: stream closed`
      var colon = line.indexOf(':');
      var field = colon === -1 ? line : line.slice(0, colon);
      var value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventName = value;
    }

    if (!dataLines.length) return null;
    var raw = dataLines.join('\n');
    if (!raw || raw === '[DONE]') return { event: 'stream.done' };

    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!parsed.event && eventName) parsed.event = eventName;
        if (!parsed.event) parsed.event = 'unknown';
        return parsed;
      }
      return { event: eventName || 'unknown', value: parsed };
    } catch (err) {
      // 半截 JSON / 非 JSON 负载：不抛错，降级成一条可展示的原始事件
      return { event: eventName || 'unparsed', raw: raw };
    }
  }

  /**
   * 增量 SSE 解析器。喂进任意切分的文本块，吐出完整事件。
   * Hermes 的 /v1/runs/{id}/events 只发 `data:` 帧 + `:` 注释心跳。
   */
  function createSseParser(options) {
    var opts = options || {};
    var maxFrameChars = opts.maxFrameChars > 0
      ? opts.maxFrameChars : DEFAULT_MAX_SSE_FRAME_CHARS;
    var buffer = '';

    function take(isFinal) {
      var out = [];
      var boundary;
      // SSE accepts CRLF, bare LF, or bare CR. Keeping raw line endings until a
      // complete blank-line boundary arrives also handles a CRLF split exactly
      // between two network chunks.
      while ((boundary = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(buffer)) !== null) {
        if (boundary.index > maxFrameChars) {
          buffer = '';
          throw sseError('SSE_FRAME_TOO_LARGE', 'SSE 单帧超过安全上限。');
        }
        var frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        var ev = parseSseFrame(frame);
        if (ev) out.push(ev);
      }
      if (buffer.length > maxFrameChars) {
        buffer = '';
        throw sseError('SSE_FRAME_TOO_LARGE', 'SSE 缓冲区超过安全上限。');
      }
      if (isFinal && buffer.replace(/\s/g, '')) {
        var tail = buffer;
        buffer = '';
        // A stream ending without the required blank line is ambiguous. Do not
        // render or persist a possibly truncated JSON payload; the caller polls
        // GET /v1/runs/{id} to reconcile authoritative terminal state instead.
        if (!/^\s*(?::[^\r\n]*(?:\r\n|\r|\n)?\s*)+$/.test(tail)) {
          throw sseError('SSE_TRUNCATED_FRAME', 'SSE 连接在完整帧结束前中断。');
        }
      }
      return out;
    }

    return {
      push: function (chunk) {
        buffer += String(chunk == null ? '' : chunk);
        return take(false);
      },
      flush: function () {
        return take(true);
      }
    };
  }

  /**
   * 客户端自管对话历史的防御性裁剪：
   *   · 只保留 user / assistant 两种角色（工具输出永远不进来）；
   *   · 单条截断、总条数封顶、总字符数封顶，从最新往回收。
   */
  function capHistory(messages, limits) {
    var lim = limits || {};
    var maxMessages = lim.maxMessages > 0 ? lim.maxMessages : 20;
    var maxChars = lim.maxChars > 0 ? lim.maxChars : 24000;
    var perMessage = lim.maxCharsPerMessage > 0 ? lim.maxCharsPerMessage : 8000;

    var clean = [];
    var list = Array.isArray(messages) ? messages : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      var content = typeof m.content === 'string'
        ? m.content
        : String(m.content == null ? '' : m.content);
      content = content.slice(0, perMessage);
      if (!content) continue;
      clean.push({ role: m.role, content: content });
    }

    if (clean.length > maxMessages) clean = clean.slice(clean.length - maxMessages);

    var out = [];
    var total = 0;
    for (var j = clean.length - 1; j >= 0; j--) {
      var len = clean[j].content.length;
      if (out.length && total + len > maxChars) break;
      total += len;
      out.unshift(clean[j]);
    }
    return out;
  }

  /**
   * 只在已确认完成时以 user+assistant 事务对追加历史。若一整对放不进配置上限，
   * 宁可整对不写，也不留下单边或部分文本。
   */
  function appendCompletedPair(history, userText, assistantText, limits) {
    var lim = limits || {};
    var perMessage = lim.maxCharsPerMessage > 0 ? lim.maxCharsPerMessage : 8000;
    var maxChars = lim.maxChars > 0 ? lim.maxChars : 24000;
    var maxMessages = lim.maxMessages > 0 ? lim.maxMessages : 20;
    var user = String(userText == null ? '' : userText).slice(0, perMessage);
    var assistant = String(assistantText == null ? '' : assistantText).slice(0, perMessage);
    var base = capHistory(history, lim);
    if (!user || !assistant || maxMessages < 2 || user.length + assistant.length > maxChars) return base;
    return capHistory(base.concat([
      { role: 'user', content: user },
      { role: 'assistant', content: assistant }
    ]), lim);
  }

  /**
   * Hermes /v1/capabilities 的鉴权自述。只有网关明确回答「我在校验鉴权」才算安全：
   * 字段缺失、为 false、结构不对，一律当成「没开鉴权」而拒绝解锁。
   * 公开的 Tailscale Funnel 只是把端口暴露到公网，它是暴露面，不是第二道认证。
   */
  function capabilitiesAuthEnforced(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    var auth = data.auth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return false;
    return auth.required === true;
  }

  /**
   * 把 GET /v1/runs/{id} 的状态字段归一成三种终态之一。
   * 认不出来就返回 null —— 「不知道」永远不许被当成「已完成」。
   */
  var TERMINAL_RUN_STATUS = {
    completed: 'completed', complete: 'completed', succeeded: 'completed',
    success: 'completed', finished: 'completed', done: 'completed',
    failed: 'failed', failure: 'failed', errored: 'failed', error: 'failed',
    cancelled: 'cancelled', canceled: 'cancelled', stopped: 'cancelled',
    aborted: 'cancelled', interrupted: 'cancelled'
  };

  function terminalRunStatus(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    var raw = body.status;
    if (raw == null) raw = body.state;
    if (raw == null && body.run && typeof body.run === 'object') raw = body.run.status;
    if (typeof raw !== 'string') return null;
    var key = raw.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(TERMINAL_RUN_STATUS, key)
      ? TERMINAL_RUN_STATUS[key] : null;
  }

  /**
   * 事件流必须自称 text/event-stream。反代的登录页、错误页也可能带 200 返回，
   * 不校验就直接读会把一整页 HTML 灌进 SSE 解析器。
   */
  function isEventStreamContentType(value) {
    return String(value == null ? '' : value)
      .split(';')[0].trim().toLowerCase() === 'text/event-stream';
  }

  /** 拼接 API 地址，两端斜杠都容错。 */
  function joinUrl(base, path) {
    var b = String(base == null ? '' : base).replace(/\/+$/, '');
    var p = String(path == null ? '' : path);
    if (p.charAt(0) !== '/') p = '/' + p;
    return b + p;
  }

  /** 单行化 + 截断，用于时间线预览。 */
  function truncate(text, max) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    var n = max > 0 ? max : 120;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /** 把网络异常翻译成人话，顺带点出最可能的配置原因。 */
  function describeNetworkError(err, apiBase) {
    var name = err && err.name ? String(err.name) : '';
    if (name === 'AbortError') return '请求已中止。';
    if (name === 'TimeoutError') return '请求超时：' + apiBase + ' 没有在预期时间内响应。';
    if (name === 'TypeError' || !name) {
      return '连不上 Hermes 网关（' + apiBase + '）。'
        + '常见原因：本机离线、Funnel 临时不可达，'
        + '或网关未放行 barryai.cn 的跨域请求与 X-Hermes-Session-Key 请求头。';
    }
    return '请求失败：' + name;
  }

  /** HTTP 状态码 → 中文说明。 */
  function describeHttpError(status) {
    if (status === 401) return '凭据无效：口令不对，或设备令牌已过期 / 已被撤销。';
    if (status === 403) return '网关拒绝了这个来源（CORS 未放行 barryai.cn）。';
    if (status === 404) return '接口不存在：请确认 Hermes API server 已启用 Runs API。';
    if (status === 429) return '并发的运行太多，稍后再试。';
    if (status >= 500) return 'Hermes 网关内部错误（HTTP ' + status + '）。';
    return '请求被拒绝（HTTP ' + status + '）。';
  }

  /** 生成一个稳定的会话 id（同一标签页内复用）。 */
  function makeSessionId() {
    var rand;
    var cryptoObj = global.crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      var buf = new Uint8Array(8);
      cryptoObj.getRandomValues(buf);
      rand = Array.prototype.map.call(buf, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } else {
      rand = Math.random().toString(16).slice(2, 18);
    }
    return 'briefs-agent-' + rand;
  }

  /**
   * 主画布一次只显示一轮。只有「正在被查看的那一轮」才有权改写画布 ——
   * 用户点回旧的一轮时，新一轮的实时增量只能写进内存，不许覆盖眼前的内容。
   */
  function canRenderTurn(selectedTurnId, turnId) {
    return selectedTurnId != null && turnId != null && selectedTurnId === turnId;
  }

  /** 运行中无输出时保留 CSS 等待占位；终态无输出时给出明确结果。 */
  function turnOutputText(turn) {
    if (!turn) return null;
    var text = String(turn.text == null ? '' : turn.text);
    if (text) return text;
    return turn.status === 'done' || turn.status === 'failed' || turn.status === 'cancelled'
      ? '本轮没有输出' : null;
  }

  /** 把一段增量并进某一轮已有的文本，遵守本页输出上限。 */
  function appendTurnText(existing, delta, maxChars) {
    var base = String(existing == null ? '' : existing);
    var raw = String(delta == null ? '' : delta);
    var limit = maxChars > 0 ? maxChars : DEFAULT_MAX_OUTPUT_CHARS;
    var room = Math.max(0, limit - base.length);
    var safe = raw.slice(0, room);
    return { text: base + safe, added: safe, capped: raw.length > safe.length };
  }

  /**
   * 倒序列表的裁剪：最新的一条在最前，所以超出上限时丢的必须是末尾那些最老的。
   * 只用到 childNodes / lastChild / removeChild，因此可以用列表桩直接测行为。
   */
  function trimNewestFirstList(list, max) {
    if (!list || !(max > 0)) return;
    while (list.childNodes.length > max) list.removeChild(list.lastChild);
  }

  /* ── 服务端会话历史：解析与投影 ────────────────────────────────
     真相在 Hermes 的 SessionDB。下面几个纯函数只负责把服务端响应压成本页要用的
     最小形状；任何畸形负载都降级成空结果，绝不抛错、绝不半途渲染。
     ───────────────────────────────────────────────────────────── */

  // 与服务端 hermes_console_store.CONSOLE_SESSION_ID_RE 同一份形状约定。
  // JS 的 $ 不像 Python 那样放过末尾换行，所以这里不需要额外的锚点技巧。
  var CONSOLE_SESSION_ID_RE = /^briefs-agent-[0-9a-f]{8,64}$/;

  function isConsoleSessionId(value) {
    return typeof value === 'string' && CONSOLE_SESSION_ID_RE.test(value);
  }

  // Hermes 压缩续写会话的 id 形状（run_agent.py 生成：时间戳 + uuid4 前 6 位）。
  // 与服务端 hermes_console_store.COMPRESSION_TIP_ID_RE 是同一份约定。
  var COMPRESSION_TIP_ID_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;
  var MAX_COMPRESSION_TIP_CHARS = 32;

  function isCompressionTipId(value) {
    return typeof value === 'string'
      && value.length <= MAX_COMPRESSION_TIP_CHARS
      && COMPRESSION_TIP_ID_RE.test(value);
  }

  /**
   * 一场会话有两个 id，别混：
   *   · 逻辑根（briefs-agent-*）—— 稳定，本机记它、URL 用它、列表标记比它；
   *   · 当前物理会话 —— 下一次 POST /v1/runs 真正写进去的那一个。
   * 上下文压缩会让 Hermes 换一个物理 id 继续写，服务端把它报成
   * `current_session_id`。它仍然是不可信输入：只接受工作台自己的
   * briefs-agent-* 或压缩续写的时间戳形状，认不出来就退回逻辑根 ——
   * 宁可下一轮再核对一次，也不拿一个野值当会话 id 用。
   */
  function parseCurrentSessionId(logicalId, raw) {
    if (isConsoleSessionId(raw) || isCompressionTipId(raw)) return raw;
    return logicalId;
  }

  /**
   * 发送门禁。四件事同时成立才放行：已解锁、没有在跑、会话指针不在核对中、
   * 指针也没有坏掉。指针没核对干净就发送，等于把下一轮追加到一段可能已经
   * 被压缩结束的对话上 —— Hermes 那边会看到两条断掉的会话。
   */
  function canSendNow(s) {
    return !!s && s.unlocked === true && !s.running
      && !s.submitting && !s.hydrating && !s.pointerPending && !s.pointerBroken;
  }

  /** GET /v1/console/sessions → [{sessionId, preview, messageCount, lastActive}]。 */
  function parseConsoleSessions(body, limit) {
    var max = limit > 0 ? limit : 30;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    var rows = body.data;
    if (!Array.isArray(rows)) return [];
    var out = [];
    for (var i = 0; i < rows.length && out.length < max; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object') continue;
      if (!isConsoleSessionId(row.session_id)) continue;
      out.push({
        sessionId: row.session_id,
        currentSessionId: parseCurrentSessionId(row.session_id, row.current_session_id),
        preview: typeof row.preview === 'string' ? row.preview : '',
        messageCount: typeof row.message_count === 'number' && isFinite(row.message_count)
          ? Math.max(0, Math.floor(row.message_count)) : 0,
        lastActive: typeof row.last_active === 'number' && isFinite(row.last_active)
          ? row.last_active : null
      });
    }
    return out;
  }

  /** GET /v1/console/sessions/{id} → {sessionId, messages}；id 不合形状就整份不要。 */
  function parseConsoleSessionDetail(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (!isConsoleSessionId(body.session_id)) return null;
    var list = Array.isArray(body.messages) ? body.messages : [];
    var messages = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m !== 'object') continue;
      // 服务端已经过滤过一轮；这里再挡一次：工具结果、推理、system prompt
      // 一律不许进入本地状态，更不许被渲染。
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (typeof m.content !== 'string') continue;
      var text = m.content.trim();
      if (!text) continue;
      messages.push({ role: m.role, content: text });
    }
    return {
      sessionId: body.session_id,
      currentSessionId: parseCurrentSessionId(body.session_id, body.current_session_id),
      messages: messages
    };
  }

  /** 把历史消息切成「已完成的一问一答」。落单的一边不重建成轮次。 */
  function historyPairs(messages) {
    var list = Array.isArray(messages) ? messages : [];
    var out = [];
    for (var i = 0; i < list.length - 1; i++) {
      var ask = list[i];
      var reply = list[i + 1];
      if (!ask || !reply) continue;
      if (ask.role !== 'user' || reply.role !== 'assistant') continue;
      out.push({
        task: String(ask.content == null ? '' : ask.content),
        output: String(reply.content == null ? '' : reply.content)
      });
      i += 1;   // 一对用掉两条
    }
    return out;
  }

  /** 会话列表上的短日期标签。认不出的时间戳返回空串，绝不显示 Invalid Date。 */
  function formatSessionTime(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return '';
    var d = new Date(seconds * 1000);
    if (isNaN(d.getTime())) return '';
    function pad(n) { return ('0' + n).slice(-2); }
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  var internals = {
    parseSseFrame: parseSseFrame,
    createSseParser: createSseParser,
    capHistory: capHistory,
    appendCompletedPair: appendCompletedPair,
    capabilitiesAuthEnforced: capabilitiesAuthEnforced,
    terminalRunStatus: terminalRunStatus,
    isEventStreamContentType: isEventStreamContentType,
    joinUrl: joinUrl,
    truncate: truncate,
    describeNetworkError: describeNetworkError,
    describeHttpError: describeHttpError,
    makeSessionId: makeSessionId,
    canRenderTurn: canRenderTurn,
    turnOutputText: turnOutputText,
    appendTurnText: appendTurnText,
    trimNewestFirstList: trimNewestFirstList,
    isConsoleSessionId: isConsoleSessionId,
    isCompressionTipId: isCompressionTipId,
    parseCurrentSessionId: parseCurrentSessionId,
    canSendNow: canSendNow,
    parseConsoleSessions: parseConsoleSessions,
    parseConsoleSessionDetail: parseConsoleSessionDetail,
    historyPairs: historyPairs,
    formatSessionTime: formatSessionTime,
    DEFAULT_MAX_SSE_FRAME_CHARS: DEFAULT_MAX_SSE_FRAME_CHARS,
    DEFAULT_MAX_OUTPUT_CHARS: DEFAULT_MAX_OUTPUT_CHARS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = internals;
  global.BarryAgentInternals = internals;

  // node / 测试环境到此为止，下面全是 DOM 装配。
  if (typeof document === 'undefined') return;

  /* ═══════════════════════════════════════════════════════════════
     第二部分：DOM 装配
     ═══════════════════════════════════════════════════════════════ */

  var CFG = global.BARRY_AGENT_CONFIG || {};
  var STORE = CFG.storage || {};
  var TIMEOUTS = CFG.timeouts || {};
  var MAX_TIMELINE = 200;
  var MAX_OUTPUT_CHARS = CFG.maxOutputChars > 0
    ? CFG.maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS;
  var MAX_SSE_FRAME_CHARS = CFG.maxSseFrameChars > 0
    ? CFG.maxSseFrameChars : DEFAULT_MAX_SSE_FRAME_CHARS;
  var SESSIONS_CFG = CFG.sessions || {};
  var SESSION_LIMIT = SESSIONS_CFG.maxItems > 0 ? SESSIONS_CFG.maxItems : 30;
  var PREVIEW_CHARS = SESSIONS_CFG.previewChars > 0 ? SESSIONS_CFG.previewChars : 90;
  // 事件流断开后向 Hermes 核对权威终态的重试节奏（毫秒，有界）。
  var RECONCILE_DELAYS = Array.isArray(CFG.reconcileDelays) && CFG.reconcileDelays.length
    ? CFG.reconcileDelays : [0, 1200, 2500, 4000, 6000];
  // 每轮收尾后向详情端点核对「这一场现在写到哪儿」的重试节奏（毫秒，有界）。
  var SESSION_POINTER_DELAYS = Array.isArray(CFG.sessionPointerDelays)
    && CFG.sessionPointerDelays.length ? CFG.sessionPointerDelays : [0, 900, 2400];

  // 「网关没开鉴权」是最危险的一种成功响应：公开 Funnel + 无鉴权 = Agent 裸奔。
  var AUTH_NOT_ENFORCED_WARNING =
    'Hermes 的 /v1/capabilities 没有声明 auth.required === true，'
    + '说明网关很可能根本没有校验口令。公开的 Tailscale Funnel 只是把端口暴露到公网，'
    + '它是暴露面而不是第二道认证 —— 这种状态下任何人都能直接驱动这台机器上的 Agent。'
    + '工作台按「失败即关门」拒绝解锁：请先在 Hermes 端启用 API 鉴权，再回来重试。';

  var CAPABILITIES_UNREADABLE_WARNING =
    '/v1/capabilities 的响应无法解析成 JSON，因此无法确认 Hermes 是否真的在校验口令。'
    + '在网关明确自述已开启鉴权之前，工作台拒绝解锁 —— 公开 Funnel 若没有鉴权，'
    + '等于把 Agent 直接放在公网上。';

  var $ = function (id) { return document.getElementById(id); };

  var dom = {
    body: document.body,
    gate: $('gate'),
    gateForm: $('gate-form'),
    gateKey: $('gate-key'),
    gateSubmit: $('gate-submit'),
    gateErr: $('gate-err'),
    gateEndpoint: $('gate-endpoint'),
    gateScope: $('gate-scope'),
    gateState: $('gate-state'),
    connChip: $('conn-chip'),
    connText: $('conn-text'),
    btnNew: $('btn-new'),
    btnHistory: $('btn-history'),
    btnLock: $('btn-lock'),
    historyDialog: $('history-dialog'),
    historyPanel: $('history-panel'),
    historyClose: $('history-close'),
    historyState: $('history-state'),
    historyList: $('history-list'),
    qaList: $('qa-list'),
    taskList: $('task-list'),
    taskEmpty: $('task-empty'),
    docTask: $('doc-task'),
    taskMeta: $('task-meta'),
    outMeta: $('out-meta'),
    outEmpty: $('out-empty'),
    outBody: $('out-body'),
    outStatus: $('out-status'),
    timeline: $('timeline'),
    timelineEmpty: $('timeline-empty'),
    composer: $('composer'),
    form: $('composer-form'),
    input: $('composer-input'),
    hint: $('composer-hint'),
    btnSend: $('btn-send'),
    btnStop: $('btn-stop')
  };

  var state = {
    token: null,        // 设备令牌：只在这里和 localStorage（主口令永远不在）
    logicalSessionId: null, // 逻辑 / 根会话 id（briefs-agent-*）：稳定，本机只记它
    sessionId: null,    // 当前**物理**会话 id：POST /v1/runs 真正写进去的那一个
    pointerPending: false,  // 正在核对「这一场现在写到哪儿」，期间不放行发送
    pointerBroken: false,   // 核对不出来：历史照看，但这一场不许再续写
    unlocked: false,
    running: false,     // 「尚未确认结束」而不是「一定在跑」：不确定时同样为 true
    uncertain: false,   // 事件流断了且核对不出终态：如实展示，不假装完成
    submitting: false,  // 同步去重闸，挡住「回车 + 点击」这种双触发
    runId: null,        // 已知后一直保留到下一次 run 创建；异常时不丢失
    controller: null,   // 当前 run 的 AbortController
    activeRun: null,    // 当前 run 的不可变 generation/controller 捕获对象
    generation: 0,     // 每次认证 / run / 锁定递增，隔离所有迟到回调
    history: [],        // [{role, content}] —— 仅完成 run 的 user+assistant 事务对
    approvalQueue: [],  // Hermes approval 无 request id，只能严格 FIFO
    taskSeq: 0,
    outText: null,      // 输出区的文本节点（只属于当前正在看的那一轮）
    caret: null,
    turns: {},          // id → 轮次记录：任务、输出、状态各自独立保存
    turnOrder: [],      // 轮次 id 的先后顺序，和 tasks 列表一致
    selectedTurnId: null,  // 主画布此刻正在显示哪一轮
    hydrationSeq: 0,    // 服务端会话载入的序号：晚发起的那次赢
    hydrating: false,   // 初始恢复未落定前不允许发送，避免迟到历史覆盖新 run
    historyOpen: false,
    historyReturnFocus: null   // 打开对话框前的焦点，关闭时还回去
  };

  function nextGeneration() {
    state.generation += 1;
    return state.generation;
  }

  function isCurrentGeneration(generation) {
    return generation === state.generation;
  }

  function isCurrentRun(run) {
    return !!run && state.activeRun === run
      && isCurrentGeneration(run.generation)
      && state.controller === run.controller;
  }

  /* ── 小工具：安全建节点（全程 textContent，无 innerHTML） ── */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function clockLabel(ts) {
    var d = ts ? new Date(ts * 1000) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    function pad(n) { return ('0' + n).slice(-2); }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ── 凭据存取：唯一允许接触设备令牌的地方 ─────────────────────
     主口令从不经过这里。它只在闸门提交那一瞬间存在于一个局部变量里，
     换到设备令牌之后立刻被置空 —— 落进 localStorage 的永远只有可撤销的令牌。
     ───────────────────────────────────────────────────────────── */
  function loadDeviceToken() {
    try { return global.localStorage.getItem(STORE.deviceToken) || null; }
    catch (e) { return null; }
  }
  function saveDeviceToken(value) {
    var old = state.token || loadDeviceToken();
    state.token = value;
    try { global.localStorage.setItem(STORE.deviceToken, value); }
    catch (e) { /* 隐私模式：仅内存，本次仍可用 */ }
    if (old && old !== value) bestEffortLogout(old);
  }
  function dropDeviceToken() {
    state.token = null;
    try { global.localStorage.removeItem(STORE.deviceToken); } catch (e) { /* noop */ }
  }
  /**
   * 只丢内存里那一枚。存储里的那把键归**写它的那个标签页**管：另一个标签页
   * 刚换发的新令牌，本页无权替它删掉。
   */
  function forgetDeviceTokenInMemory() {
    state.token = null;
  }

  /** 本机记得的**逻辑根**会话 id。存储里的东西同样是不可信输入，用之前先校形。 */
  function rememberedSessionId() {
    var id = null;
    try { id = global.localStorage.getItem(STORE.sessionId); } catch (e) { /* noop */ }
    return isConsoleSessionId(id) ? id : null;
  }

  function forgetRememberedSessionId() {
    try { global.localStorage.removeItem(STORE.sessionId); } catch (e) { /* noop */ }
  }

  /** 当前**物理**会话 id；一场都还没有就现开一场。非机密标识，不是凭据。 */
  function sessionId() {
    if (!state.sessionId) newSessionId();
    return state.sessionId;
  }

  /**
   * 同时落下逻辑根与当前物理会话。localStorage 里**只**留逻辑根 ——
   * 物理 id 会随压缩作废，把它腌进浏览器只会留下一个过期指针。
   */
  function setSessionId(logicalId, currentId) {
    var logical = logicalId;
    state.logicalSessionId = logical;
    state.sessionId = parseCurrentSessionId(logical, currentId);
    // 采纳一份身份（新开一场 / 从历史选一场 / 核对回来的指针）就意味着指针是当下的：
    // 两个闸门一并归零。否则在核对途中切走一场会话，会留下一个永远不会被兑现的
    // pending 把发送按钮锁死；「重新选一次这一场」也正是坏指针的恢复路径。
    state.pointerPending = false;
    state.pointerBroken = false;
    try { global.localStorage.setItem(STORE.sessionId, logical); } catch (e) { /* noop */ }
  }

  function newSessionId() {
    var fresh = makeSessionId();
    // 全新的一场：逻辑根与物理会话就是同一个 id，压缩之后才会分叉。
    setSessionId(fresh, fresh);
    return state.sessionId;
  }

  /** 只清内存里的会话身份；本机记住的那个非机密 id 留着，重新解锁还能接上。 */
  function resetSessionIdentity() {
    state.logicalSessionId = null;
    state.sessionId = null;
    state.pointerPending = false;
    state.pointerBroken = false;
  }

  /**
   * 连本机记住的那个 id 一起忘掉（手动锁定、跨标签页撤销时用）。
   * 刻意**不**顺手铸一个新 id：那会把「记得的那一场」永久顶掉，
   * 下次解锁就再也接不回最近那场对话了。服务端历史一条都不动。
   */
  function forgetSessionIdentity() {
    resetSessionIdentity();
    forgetRememberedSessionId();
  }

  /** 只清本页内存里的对话视图。服务端 SessionDB 里的历史一条都不动。 */
  function clearLocalHistory() {
    state.history = [];
  }

  /* ── 网络层 ── */
  function authHeaders(extra) {
    var h = {};
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    h.Authorization = 'Bearer ' + state.token;
    h[CFG.sessionKeyHeader || 'X-Hermes-Session-Key'] = CFG.sessionKey;
    return h;
  }

  /**
   * 带超时的请求。三种鉴权姿态：
   *   · 默认         —— 用 state 里的设备令牌；
   *   · opts.token   —— 用显式传入的那一枚（复验、登出时用）；
   *   · opts.anonymous —— 完全不带 Authorization（只有换令牌那一发用得上）。
   * 凭据不会出现在任何调用点的 URL 或参数里。
   */
  function apiFetch(path, options) {
    var opts = options || {};
    var controller = new AbortController();
    var timer = opts.timeout ? global.setTimeout(function () { controller.abort(); }, opts.timeout) : null;

    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
    }

    var headers = {};
    if (!opts.anonymous) {
      headers = opts.token
        ? { Authorization: 'Bearer ' + opts.token, 'X-Hermes-Session-Key': CFG.sessionKey }
        : authHeaders();
    }
    if (opts.json) headers['Content-Type'] = 'application/json';
    if (opts.accept) headers.Accept = opts.accept;

    return global.fetch(joinUrl(CFG.apiBase, path), {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.json ? JSON.stringify(opts.json) : undefined,
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    }).then(function (res) {
      if (timer) global.clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) global.clearTimeout(timer);
      throw err;
    });
  }

  /* ── 连接状态灯 ── */
  function setConn(stateName, text) {
    dom.connChip.setAttribute('data-state', stateName);
    dom.connText.textContent = text;
  }

  /* ── 闸门 ↔ 工作台 ── */
  function showGate(message) {
    state.unlocked = false;
    closeHistoryDialog();
    dom.body.classList.add('is-locked');
    setConn('idle', '已锁定');
    dom.gateState.textContent = message ? '需要重新验证' : '等待口令';
    if (message) {
      dom.gateErr.textContent = message;
      dom.gateErr.hidden = false;
    } else {
      dom.gateErr.hidden = true;
      dom.gateErr.textContent = '';
    }
    dom.gateKey.value = '';
    dom.gateSubmit.disabled = false;
    dom.gateSubmit.textContent = '解锁工作台';
    setEnabled(false);
    if (dom.gateKey.focus) {
      try { dom.gateKey.focus(); } catch (e) { /* noop */ }
    }
  }

  function unlock() {
    state.unlocked = true;
    // 上一次会话留下的指针状态不该跨越一次解锁继续挡着发送。
    state.pointerPending = false;
    state.pointerBroken = false;
    dom.body.classList.remove('is-locked');
    dom.gateKey.value = '';
    dom.gateErr.hidden = true;
    setEnabled(true);
    setConn('ok', '已连接');
    dom.hint.textContent = 'Ctrl / ⌘ + Enter 发送';
    try { dom.input.focus(); } catch (e) { /* noop */ }
  }

  function setEnabled(on) {
    dom.input.disabled = !on;
    dom.btnSend.disabled = !on || !canSendNow(state);
    dom.btnStop.disabled = !on || !state.running;
    // 「新会话」永远是出路：即使会话指针核对不出来，也必须能重新开一场。
    dom.btnNew.disabled = !on || state.running;
    dom.btnHistory.disabled = !on;
    dom.btnLock.disabled = !on;
    var buttons = dom.qaList.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !on;
  }

  /**
   * 401 一律视为设备令牌失效。generation 参数让迟到的 401 无法炸掉更新的会话：
   * 已经换过口令 / 重新解锁之后，旧回调只能安静退场。
   *
   * 注意这里只清**本地**：服务端 SessionDB 里的历史一条都不动，
   * 重新解锁之后它们还在，这正是这次改造要的效果。
   */
  function handleUnauthorized(generation) {
    if (generation !== undefined && !isCurrentGeneration(generation)) return;
    abortRun('已锁定');
    dropDeviceToken();
    clearLocalHistory();
    resetSessionIdentity();
    closeHistoryDialog();
    clearCanvas();
    showGate('设备令牌已失效（HTTP 401），请重新输入口令。服务端的历史会话不受影响。');
  }

  /**
   * 锁定前的尽力远端停止。已知 run_id 才有得停 —— 这也是本页无法消除的窗口：
   * 若 POST /v1/runs 已经到达 Hermes、而它的 run_id 响应在回程丢了，
   * 本页从头到尾都不知道那个 id，既停不掉也查不到。详见 ARCHITECTURE.md。
   */
  function bestEffortStopActiveRun() {
    if (!state.runId || !state.token) return;
    var runId = state.runId;
    // 请求头在 apiFetch 调用的这一刻就构造好了，所以随后立刻清凭据也不影响这一发。
    apiFetch('/v1/runs/' + encodeURIComponent(runId) + '/stop', {
      method: 'POST',
      json: {},
      timeout: TIMEOUTS.stopRun || 10000
    }).catch(function () { /* 锁定优先，远端停止仅尽力而为 */ });
  }

  /**
   * 锁定时尽力撤销这一枚设备令牌。撤销只影响这台设备：主口令不受影响，
   * 别的设备的令牌不受影响，服务端历史更是一条都不动。
   */
  function bestEffortLogout(token) {
    if (!token) return;
    apiFetch('/v1/console/auth/logout', {
      method: 'POST',
      json: {},
      token: token,
      timeout: TIMEOUTS.logout || 8000
    }).catch(function () { /* 锁定优先，撤销仅尽力而为 */ });
  }

  function lockNow() {
    // 顺序有意为之：stop 与 logout 都要赶在令牌还在时发出去，再清本地。
    bestEffortStopActiveRun();
    bestEffortLogout(state.token);
    abortRun('已锁定');
    dropDeviceToken();
    clearLocalHistory();
    // 忘掉身份，而不是铸一个新的：下次解锁仍然能接回最近那一场服务端会话。
    forgetSessionIdentity();
    closeHistoryDialog();
    clearCanvas();
    showGate('');
    dom.gateState.textContent = '已手动锁定';
  }

  /* ── 画布渲染 ─────────────────────────────────────────────────
     主画布是「一次显示一轮」的取景器，不是一条流水账：每一轮的任务、输出、
     状态都存在 state.turns 里，画布只负责把 state.selectedTurnId 那一轮画出来。
     所以任何写画布的动作都要先过 turnOnCanvas() 这道门 —— 否则用户点回旧的一轮
     时，正在跑的新一轮会把眼前的内容冲掉。
     ───────────────────────────────────────────────────────────── */

  function clearCanvas() {
    dom.docTask.textContent = '尚未下达任务。';
    dom.taskMeta.textContent = '—';
    dom.outMeta.textContent = '待命';
    dom.outEmpty.hidden = false;
    dom.outBody.hidden = true;
    dom.outBody.setAttribute('aria-busy', 'false');
    clear(dom.outBody);
    state.outText = null;
    state.caret = null;
    dom.outStatus.hidden = true;
    dom.outStatus.textContent = '';
    dom.outStatus.removeAttribute('data-tone');
    clear(dom.timeline);
    dom.timelineEmpty.hidden = false;
    clear(dom.taskList);
    dom.taskEmpty.hidden = false;
    state.taskSeq = 0;
    state.turns = {};
    state.turnOrder = [];
    state.selectedTurnId = null;
  }

  /** 这次运行对应的轮次记录；轮次已被清掉（新会话 / 锁定）时返回 null。 */
  function turnFor(run) {
    return run && run.turnId != null ? state.turns[run.turnId] || null : null;
  }

  /** 画布门禁：只有正在被查看的那一轮才允许改写 DOM。 */
  function turnOnCanvas(turn) {
    return canRenderTurn(state.selectedTurnId, turn ? turn.id : null);
  }

  /** 把某一轮完整地画到主画布上（切换轮次、以及每次新任务都会走这里）。 */
  function renderTurn(turn) {
    if (!turn) return;
    dom.docTask.textContent = turn.task;
    dom.taskMeta.textContent = turn.time;
    dom.outMeta.textContent = turn.outMeta;
    dom.outEmpty.hidden = true;
    dom.outBody.hidden = false;
    dom.outBody.setAttribute('aria-busy', turn.live ? 'true' : 'false');
    clear(dom.outBody);
    state.outText = null;
    state.caret = null;
    var outputText = turnOutputText(turn);
    // 运行中且无输出时保持真空，让 CSS 的「等待模型输出…」露出来。
    if (outputText != null) {
      // 关键：历史输出同样只走文本节点，不存在把模型输出当 HTML 的路径。
      state.outText = document.createTextNode(outputText);
      dom.outBody.appendChild(state.outText);
      if (turn.live) {
        state.caret = el('span', 'out-caret');
        state.caret.setAttribute('aria-hidden', 'true');
        dom.outBody.appendChild(state.caret);
      }
    }
    if (turn.statusText) {
      dom.outStatus.textContent = turn.statusText;
      if (turn.statusTone) dom.outStatus.setAttribute('data-tone', turn.statusTone);
      else dom.outStatus.removeAttribute('data-tone');
      dom.outStatus.hidden = false;
    } else {
      dom.outStatus.hidden = true;
      dom.outStatus.textContent = '';
      dom.outStatus.removeAttribute('data-tone');
    }
  }

  /** 切到某一轮：更新选中态，并把那一轮重画到主画布。时间线是整场会话的，不动。 */
  function selectTurn(id) {
    var turn = state.turns[id];
    if (!turn) return;
    state.selectedTurnId = turn.id;
    for (var i = 0; i < state.turnOrder.length; i++) {
      var other = state.turns[state.turnOrder[i]];
      if (!other || !other.btn) continue;
      if (other.id === turn.id) other.btn.setAttribute('aria-current', 'true');
      else other.btn.removeAttribute('aria-current');
    }
    renderTurn(turn);
  }

  function beginOutput(run) {
    var turn = turnFor(run);
    if (turn) { turn.live = true; turn.started = true; }
    if (turn && !turnOnCanvas(turn)) return;
    dom.outEmpty.hidden = true;
    dom.outBody.hidden = false;
    dom.outBody.setAttribute('aria-busy', 'true');
    clear(dom.outBody);
    state.outText = document.createTextNode(turn ? turn.text : '');
    dom.outBody.appendChild(state.outText);
    state.caret = el('span', 'out-caret');
    state.caret.setAttribute('aria-hidden', 'true');
    dom.outBody.appendChild(state.caret);
  }

  function endOutput(run) {
    var turn = turnFor(run);
    if (turn) turn.live = false;
    // 没有轮次上下文（本地强制收束）时照样收掉光标，别留一个永远闪的假运行态。
    if (turn && !turnOnCanvas(turn)) return;
    dom.outBody.setAttribute('aria-busy', 'false');
    if (state.caret && state.caret.parentNode) state.caret.parentNode.removeChild(state.caret);
    state.caret = null;
  }

  function appendDelta(text, run) {
    var turn = turnFor(run);
    var onCanvas = turnOnCanvas(turn);
    // 先把文本节点建好，再累积；顺序反了会把这一段增量渲染两次。
    if (onCanvas && !state.outText) beginOutput(run);
    var base = turn ? turn.text : (run ? run.text : '');
    var result = appendTurnText(base, text, MAX_OUTPUT_CHARS);
    if (turn) turn.text = result.text;
    if (run) run.text = result.text;
    if (onCanvas && result.added) {
      // 关键：文本节点写入，模型输出永远不会被当成 HTML。
      state.outText.appendData(result.added);
      maybeScroll();
    }
    if (result.capped && (!run || !run.outputCapped)) {
      if (run) run.outputCapped = true;
      setStatus('warn', '模型输出超过本页安全上限，已停止继续渲染；最终状态仍会向 Hermes 核对。', run);
    }
  }

  function replaceOutput(text, run) {
    var turn = turnFor(run);
    var raw = String(text == null ? '' : text);
    var safe = raw.slice(0, MAX_OUTPUT_CHARS);
    if (turn) { turn.text = safe; turn.started = true; }
    if (run) {
      run.text = safe;
      // 权威完整输出可以覆盖此前的增量状态，因此只看最终文本本身是否超限。
      run.outputCapped = raw.length > safe.length;
    }
    if (turnOnCanvas(turn)) {
      if (!state.outText) beginOutput(run);
      state.outText.data = safe;
      maybeScroll();
    }
    if (raw.length > safe.length) {
      setStatus('warn', '最终输出超过本页安全上限，已截断显示，且不会写入不完整的历史。', run);
    }
  }

  function setStatus(tone, text, run) {
    var turn = turnFor(run);
    if (turn) {
      turn.statusTone = tone || '';
      turn.statusText = text;
      if (!turnOnCanvas(turn)) return;
    }
    dom.outStatus.textContent = text;
    if (tone) dom.outStatus.setAttribute('data-tone', tone);
    else dom.outStatus.removeAttribute('data-tone');
    dom.outStatus.hidden = false;
  }

  /** 把一条与具体 run 无关的提示写到当前正在看的那一轮上。 */
  function setSelectedTurnStatus(tone, text) {
    if (state.selectedTurnId == null) return;
    setStatus(tone, text, { turnId: state.selectedTurnId });
  }

  /** 结果区那行小标题（生成中 / 已完成 / 核对中…），同样按轮存、按轮显示。 */
  function setOutMeta(text, run) {
    var turn = turnFor(run);
    if (turn) {
      turn.outMeta = text;
      if (!turnOnCanvas(turn)) return;
    }
    dom.outMeta.textContent = text;
  }

  /* 只在用户本来就贴着底部时才自动滚动，别抢正在往回看的人的滚动条。 */
  function nearBottom() {
    var doc = document.documentElement;
    var gap = doc.scrollHeight - (global.pageYOffset || doc.scrollTop) - doc.clientHeight;
    return gap < 140;
  }
  var stickToBottom = true;
  global.addEventListener('scroll', function () { stickToBottom = nearBottom(); }, { passive: true });
  function maybeScroll() {
    if (!stickToBottom) return;
    global.scrollTo(0, document.documentElement.scrollHeight);
  }

  /* ── 时间线 ── */
  function addEvent(kind, tone, text, sub, ts) {
    dom.timelineEmpty.hidden = true;
    var li = el('li', 'tl-item');
    if (tone) li.setAttribute('data-tone', tone);
    li.appendChild(el('span', 'tl-time', clockLabel(ts)));
    var main = el('div', 'tl-main');
    main.appendChild(el('p', 'tl-kind', kind));
    if (text) main.appendChild(el('p', 'tl-text', text));
    if (sub) main.appendChild(el('p', 'tl-sub', sub));
    li.appendChild(main);
    // 倒序：最新的事件排在最上面，不必滚到底才看得见正在发生什么。
    dom.timeline.insertBefore(li, dom.timeline.firstChild);
    trimNewestFirstList(dom.timeline, MAX_TIMELINE);
    return main;
  }

  /* ── 会话轮次：每条任务都建一轮，并自动接管主画布 ── */
  function addTask(text) {
    dom.taskEmpty.hidden = true;
    state.taskSeq += 1;
    var id = state.taskSeq;
    var label = truncate(text, 90);
    var li = el('li', 'task-item');
    var btn = el('button', 'task-btn');
    btn.type = 'button';
    btn.setAttribute('data-state', 'running');
    btn.setAttribute('aria-label', '第 ' + id + ' 轮任务：' + label);
    btn.appendChild(el('span', 't-idx', ('0' + id).slice(-2)));
    btn.appendChild(el('span', 't-text', label));
    btn.addEventListener('click', function () { selectTurn(id); });
    li.appendChild(btn);
    dom.taskList.appendChild(li);

    state.turns[id] = {
      id: id,
      task: text,
      time: clockLabel(),
      text: '',
      outMeta: '运行中',
      status: 'running',
      started: false,   // 这一轮是否已经有过输出：决定要不要显示「等待模型输出…」
      statusTone: '',
      statusText: '',
      live: true,
      btn: btn
    };
    state.turnOrder.push(id);
    selectTurn(id);   // 新任务自动选中：下达指令后画布就该跟着走
    return id;
  }

  function markTask(id, taskState) {
    var turn = state.turns[id];
    if (!turn) return;
    turn.status = taskState;
    turn.live = false;
    if (turn.btn) turn.btn.setAttribute('data-state', taskState);
    if (turnOnCanvas(turn)) renderTurn(turn);
  }

  /* ── 审批：服务端只解析「最老 pending」，因此 UI 必须是单一 FIFO ── */
  function clearApprovalQueue(reason) {
    var queue = state.approvalQueue.splice(0);
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i];
      item.allow.disabled = true;
      item.deny.disabled = true;
      if (item.box && item.box.parentNode) item.box.parentNode.removeChild(item.box);
    }
    if (reason && queue.length) addEvent('APPROVAL', 'warn', reason);
  }

  function refreshApprovalQueue() {
    for (var i = 0; i < state.approvalQueue.length; i++) {
      var item = state.approvalQueue[i];
      var isHead = i === 0;
      item.allow.disabled = !isHead || item.busy;
      item.deny.disabled = !isHead || item.busy;
      item.box.setAttribute('data-queue-state', isHead ? 'active' : 'queued');
      item.queueState.textContent = isHead
        ? (item.busy ? '正在提交最早一项审批…' : '当前最早审批，可操作')
        : '排队中 · 前方 ' + i + ' 项；为保证 FIFO 暂不可操作';
    }
  }

  function renderApproval(run, ev) {
    if (!isCurrentRun(run)) return;
    var question = ev.question || ev.message || ev.prompt || ev.description || '';
    var tool = ev.tool || ev.tool_name || ev.name || '未知工具';
    var main = addEvent('APPROVAL', 'warn', '需要人工审批：' + tool,
      truncate(ev.preview || ev.command || ev.arguments || '', 200), ev.timestamp);

    var box = el('div', 'tl-approval');
    box.appendChild(el('p', 'ap-q', question || '小八请求执行上述操作，是否放行？'));
    var queueState = el('p', 'ap-state', '排队中');
    box.appendChild(queueState);
    var btns = el('div', 'ap-btns');
    var allow = el('button', 'ap-btn', '本次允许');
    var deny = el('button', 'ap-btn ap-btn-deny', '拒绝');
    allow.type = 'button';
    deny.type = 'button';

    var item = {
      run: run,
      box: box,
      queueState: queueState,
      allow: allow,
      deny: deny,
      busy: false
    };

    function respond(choice) {
      if (!isCurrentRun(run) || state.approvalQueue[0] !== item || item.busy) return;
      item.busy = true;
      refreshApprovalQueue();
      apiFetch('/v1/runs/' + encodeURIComponent(run.runId) + '/approval', {
        method: 'POST',
        json: { choice: choice },
        timeout: TIMEOUTS.approval || 10000
      }).then(function (res) {
        if (!isCurrentRun(run) || state.approvalQueue[0] !== item) return;
        if (res.status === 401) { handleUnauthorized(run.generation); return; }
        if (!res.ok) {
          item.busy = false;
          refreshApprovalQueue();
          addEvent('APPROVAL', 'err', describeHttpError(res.status));
          return;
        }
        state.approvalQueue.shift();
        if (box.parentNode) box.parentNode.removeChild(box);
        addEvent('APPROVAL', 'ok', choice === 'once' ? '已放行最早一项操作' : '已拒绝最早一项操作');
        refreshApprovalQueue();
      }).catch(function (err) {
        if (!isCurrentRun(run) || state.approvalQueue[0] !== item) return;
        // 传输失败时服务端是否收到请求不可证明；保持当前卡片为队首并重新启用，
        // 不擅自推进到后一张卡，避免错配审批。
        item.busy = false;
        refreshApprovalQueue();
        addEvent('APPROVAL', 'err', describeNetworkError(err, CFG.apiBase));
      });
    }

    allow.addEventListener('click', function () { respond('once'); });
    deny.addEventListener('click', function () { respond('deny'); });
    btns.appendChild(allow);
    btns.appendChild(deny);
    box.appendChild(btns);
    main.appendChild(box);
    state.approvalQueue.push(item);
    refreshApprovalQueue();
    setStatus('warn', state.approvalQueue.length === 1
      ? '小八在等待最早一项审批，右栏可以放行或拒绝。'
      : '收到多项审批；后续卡片已按 FIFO 排队并禁用。', run);
  }

  /* ── 事件分发 ── */
  function handleEvent(ev, run) {
    // 迟到 / 越代事件一律丢弃：只有当前 run 才有权改画布、审批队列与历史。
    if (!isCurrentRun(run)) return;
    var name = ev && ev.event ? String(ev.event) : 'unknown';

    switch (name) {
      case 'message.delta':
        if (!run.started) { run.started = true; beginOutput(run); setOutMeta('生成中', run); }
        appendDelta(ev.delta, run);
        break;

      case 'tool.started':
        addEvent('TOOL ▶', null, String(ev.tool || '未命名工具'),
          truncate(ev.preview, 180), ev.timestamp);
        break;

      case 'tool.completed':
        addEvent(ev.error ? 'TOOL ✗' : 'TOOL ✓', ev.error ? 'err' : 'ok',
          String(ev.tool || '未命名工具'),
          (ev.duration != null ? ev.duration + 's' : '') + (ev.error ? ' · 失败' : ''),
          ev.timestamp);
        break;

      case 'reasoning.available':
        addEvent('THINK', null, truncate(ev.text, 200), '', ev.timestamp);
        break;

      case 'approval.request':
        renderApproval(run, ev);
        break;

      case 'run.completed':
        // 唯一的权威完成信号。output 若在场就以它为准（增量可能有缺口）。
        if (ev.output != null) { replaceOutput(ev.output, run); run.started = true; }
        // 终态事件与前序 delta 在同一条有序 SSE 流里；收到它即可证明输出完整。
        run.outputComplete = true;
        var usage = ev.usage || {};
        var bits = [];
        if (usage.input_tokens) bits.push('输入 ' + usage.input_tokens);
        if (usage.output_tokens) bits.push('输出 ' + usage.output_tokens);
        addEvent('RUN ✓', 'ok', '运行完成', bits.join(' · '), ev.timestamp);
        setStatus('ok', '运行完成。' + (bits.length ? ' token：' + bits.join(' · ') : ''), run);
        applyTerminal(run, 'completed');
        break;

      case 'run.failed':
        addEvent('RUN ✗', 'err', '运行失败', truncate(ev.error, 200), ev.timestamp);
        setStatus('err', '运行失败：' + (ev.error ? truncate(ev.error, 400) : '未提供错误详情')
          + '（失败的输出不会写入会话历史）', run);
        applyTerminal(run, 'failed');
        break;

      case 'run.cancelled':
        addEvent('RUN ⏹', 'warn', '运行已取消', '', ev.timestamp);
        setStatus('warn', 'Hermes 已确认运行取消；这一轮输出不会写入会话历史。', run);
        applyTerminal(run, 'cancelled');
        break;

      case 'stream.done':
        break;

      case 'unparsed':
        addEvent('RAW', 'warn', truncate(ev.raw, 200), '无法解析的事件负载');
        break;

      default:
        addEvent(truncate(name, 24).toUpperCase(), null, '', '', ev && ev.timestamp);
        break;
    }
  }

  /* ── 运行生命周期 ─────────────────────────────────────────────
     三条不变量，改这一段前请先读：
       1. 只有 Hermes 的权威终态（SSE 终态事件，或 GET /v1/runs/{id} 的状态）
          才能宣布一次运行结束。事件流断掉本身什么都不证明。
       2. run_id 一旦拿到就一直保留，直到确认终态、或用户主动锁定 / 开新会话。
       3. 只有 completed 且输出完整未截断，才把 user+assistant 成对写进历史。
     ───────────────────────────────────────────────────────────── */

  function delay(ms) {
    return new Promise(function (resolve) {
      if (!(ms > 0)) { resolve(); return; }
      global.setTimeout(resolve, ms);
    });
  }

  /** 「这条回调已经过期」的静默出口，不参与任何错误展示。 */
  function abandoned() {
    var err = new Error('__abandoned__');
    err.abandoned = true;
    return err;
  }

  /** 把异常翻译成给人看的一句话，HTTP / SSE / 网络三类都覆盖。 */
  function errorText(err) {
    var msg = err && err.message ? String(err.message) : '';
    if (err && err.name === 'SseParseError') return msg;
    if (msg && (msg.indexOf('HTTP') !== -1 || msg.indexOf('Hermes') !== -1
      || msg.indexOf('event-stream') !== -1)) return msg;
    return describeNetworkError(err, CFG.apiBase);
  }

  /**
   * 本地强制收束：中止传输并抬升 generation，让所有在途回调彻底失去改写权。
   * 只做本地清理 —— 远端是否还在跑由调用方负责（lockNow 会先发远端 stop）。
   */
  function abortRun(reason) {
    var run = state.activeRun;
    if (state.controller) {
      try { state.controller.abort(); } catch (e) { /* noop */ }
    }
    nextGeneration();
    state.controller = null;
    state.activeRun = null;
    state.running = false;
    state.uncertain = false;
    state.runId = null;
    state.submitting = false;
    // 强制收束会抬 generation，在途的指针核对随之作废；两个闸门一并归零，
    // 否则「新会话」之后发送按钮会被一个已经没人会兑现的 pending 永久挡住。
    state.pointerPending = false;
    state.pointerBroken = false;
    clearApprovalQueue();
    endOutput(run);
    if (state.unlocked) {
      dom.btnSend.disabled = !canSendNow(state);
      dom.btnStop.disabled = true;
      dom.btnNew.disabled = false;
      dom.hint.textContent = reason || 'Ctrl / ⌘ + Enter 发送';
      setConn('ok', '已连接');
    }
  }

  /** 终态已确认后回到待命。这是唯一允许在正常路径上清掉 run_id 的出口。 */
  function releaseRun(run) {
    if (!isCurrentRun(run)) return;
    try { run.controller.abort(); } catch (e) { /* noop */ }
    state.controller = null;
    state.activeRun = null;
    state.running = false;
    state.uncertain = false;
    state.runId = null;
    state.submitting = false;
    endOutput(run);
    setEnabled(state.unlocked);
    if (state.unlocked) {
      dom.hint.textContent = 'Ctrl / ⌘ + Enter 发送';
      setConn('ok', '已连接');
    }
  }

  /** 终态未确认：保留 run_id 与运行态，如实告诉用户「本页也不知道」。 */
  function markUncertain(run, detail) {
    if (!isCurrentRun(run)) return;
    state.uncertain = true;
    state.running = true;   // 未确认结束 ⇒ 继续禁用新会话、保留「停止」
    state.submitting = false;
    endOutput(run);
    setOutMeta('状态未确认', run);
    setConn('err', '状态未确认');
    setEnabled(state.unlocked);
    dom.hint.textContent = '状态未确认 · ' + truncate(run.runId, 22);
    addEvent('RUN ?', 'warn', '终态未确认', truncate(detail, 200));
    setStatus('warn',
      '无法确认这次运行是否已经结束（' + truncate(detail, 160) + '）。运行 ID '
      + run.runId + ' 已保留：可以再点「停止」重新向 Hermes 核对，或点「锁定」'
      + '清空本地凭据。本页不会替 Hermes 宣布完成，这一轮输出也不会写进会话历史。', run);
  }

  /** 只在确认 completed 且输出完整时，才成对写入历史。 */
  function persistCompletedPair(run) {
    if (run.persisted) return;
    if (!run.outputComplete) {
      addEvent('HISTORY', 'warn', '无法证明输出完整',
        'Hermes 已确认运行完成，但本页未拿到完整输出；这一轮不写入会话历史');
      return;
    }
    if (run.outputCapped) {
      addEvent('HISTORY', 'warn', '输出超过本页上限被截断',
        '为免残缺上下文流回 Hermes，这一轮不写入会话历史');
      return;
    }
    if (!run.task || !run.text) return;
    run.persisted = true;
    // 事务性追加：要么 user+assistant 一起进，要么整对不进。
    // 只进内存：跨设备恢复走服务端 SessionDB，浏览器不再是历史的家。
    state.history = appendCompletedPair(state.history, run.task, run.text, CFG.history);
  }

  /** 唯一的终态落地点：SSE 终态事件与 GET /v1/runs/{id} 核对都汇到这里。 */
  function applyTerminal(run, terminal) {
    if (!isCurrentRun(run)) return;
    run.terminal = terminal;
    clearApprovalQueue('运行已进入终态，未处理的审批卡片全部作废。');
    markTask(run.turnId, terminal === 'completed' ? 'done' : terminal);
    if (terminal === 'completed') {
      persistCompletedPair(run);
      setOutMeta('已完成', run);
    } else {
      setOutMeta(terminal === 'failed' ? '失败' : '已取消', run);
    }
    var generation = run.generation;
    // 先关门再放行：这一轮期间 Hermes 可能因为上下文压缩换了物理会话 id，
    // 而事件流里看不到这件事。核对清楚之前不许再发下一条，否则下一轮会被
    // 追加到一段已经结束的对话上。
    if (state.unlocked && state.logicalSessionId) state.pointerPending = true;
    releaseRun(run);
    beginSessionPointerReconcile(generation);
  }

  /* ── 会话指针核对 ─────────────────────────────────────────────
     上下文压缩是**运行途中**发生的：Hermes 把当前会话标成结束，另起一个
     `YYYYMMDD_HHMMSS_hex6` 的续写会话接着写。本页从 SSE 里看不到这一步，
     所以每轮收尾都要向详情端点问一次「这一场现在写到哪儿」。
     问不出来就 fail closed：历史照看、可以开新会话，但不许继续写这一场。
     ───────────────────────────────────────────────────────────── */

  function beginSessionPointerReconcile(generation) {
    if (!state.unlocked || !state.logicalSessionId) return Promise.resolve(false);
    state.pointerPending = true;
    state.pointerBroken = false;
    setEnabled(true);
    dom.hint.textContent = '正在核对会话指针…';
    return reconcileSessionPointer(state.logicalSessionId, generation, 0);
  }

  /** 有界重试。逻辑根中途被换掉（开了新会话 / 载入了别的一场）就安静退场。 */
  function reconcileSessionPointer(logicalId, generation, attempt) {
    if (!isCurrentGeneration(generation) || logicalId !== state.logicalSessionId) {
      return Promise.resolve(false);
    }
    if (attempt >= SESSION_POINTER_DELAYS.length) {
      failSessionPointer(generation, logicalId);
      return Promise.resolve(false);
    }
    function retry() {
      return reconcileSessionPointer(logicalId, generation, attempt + 1);
    }
    return delay(SESSION_POINTER_DELAYS[attempt]).then(function () {
      if (!isCurrentGeneration(generation) || logicalId !== state.logicalSessionId) return null;
      return apiFetch('/v1/console/sessions/' + encodeURIComponent(logicalId), {
        timeout: TIMEOUTS.sessionDetail || 15000
      });
    }).then(function (res) {
      if (!res || !isCurrentGeneration(generation)) return false;
      if (res.status === 401) { handleUnauthorized(generation); return false; }
      if (!res.ok) return retry();
      return res.json().then(function (body) {
        if (!isCurrentGeneration(generation) || logicalId !== state.logicalSessionId) return false;
        var detail = parseConsoleSessionDetail(body);
        // 只认「同一个逻辑根」的回答；对不上就当没问到，别把指针挪到别处去。
        if (!detail || detail.sessionId !== logicalId) return retry();
        adoptSessionPointer(detail);
        return true;
      }, retry);
    }, function (err) {
      if (!isCurrentGeneration(generation)) return false;
      return retry();
    });
  }

  /** 只取指针，不重放历史：刚跑完的那一轮已经在画布与本地历史里了。 */
  function adoptSessionPointer(detail) {
    var rotated = detail.currentSessionId !== state.sessionId;
    setSessionId(detail.sessionId, detail.currentSessionId);
    state.pointerPending = false;
    setEnabled(state.unlocked);
    if (state.unlocked) {
      dom.hint.textContent = 'Ctrl / ⌘ + Enter 发送';
      setConn('ok', '已连接');
    }
    if (rotated) {
      addEvent('SESSION ⇄', 'ok', '这一场已被压缩续写',
        '后续指令写入 ' + truncate(detail.currentSessionId, 32));
    }
  }

  /** 核对不出来：历史留着看得见，但这一场不许再续写。新会话仍然是开着的门。 */
  function failSessionPointer(generation, logicalId) {
    if (!isCurrentGeneration(generation) || logicalId !== state.logicalSessionId) return;
    state.pointerPending = false;
    state.pointerBroken = true;
    setEnabled(state.unlocked);
    setConn('err', '会话指针未确认');
    dom.hint.textContent = '会话指针未确认 · 这一场无法继续';
    addEvent('SESSION ?', 'warn', '无法确认这一场会话当前写在哪儿',
      '已停用继续发送，避免把下一轮追加到一段已经结束的对话上');
    setSelectedTurnStatus('warn',
      '这一轮已经结束，但本页没能向 Hermes 确认这一场会话当前的写入位置'
      + '（上下文压缩会换一个会话 id 继续写）。为免下一轮被追加到一段已经结束的'
      + '对话上，继续发送已被停用 —— 请刷新页面，或从「历史会话」里重新选一次'
      + '这一场；也可以直接点「新会话」另起一场。已经看到的内容不受影响。');
  }

  /** 向 Hermes 查这次运行的权威状态。任何读不出来的情况都如实返回，绝不猜。 */
  function fetchRunState(run) {
    return apiFetch('/v1/runs/' + encodeURIComponent(run.runId), {
      timeout: TIMEOUTS.runState || 10000
    }).then(function (res) {
      if (res.status === 401) { handleUnauthorized(run.generation); return { handled: true }; }
      if (!res.ok) return { error: describeHttpError(res.status) };
      return res.json().then(function (body) {
        var terminal = terminalRunStatus(body);
        return terminal
          ? { terminal: terminal, body: body }
          : { pending: true, error: 'Hermes 尚未报告终态（运行可能仍在继续）' };
      }, function () {
        return { error: '运行状态响应无法解析成 JSON。' };
      });
    }, function (err) {
      return { error: describeNetworkError(err, CFG.apiBase) };
    });
  }

  /** 有界轮询核对。轮完仍不确定就进入「未确认」态，绝不假装完成。 */
  function reconcileRun(run, reason) {
    if (!isCurrentRun(run) || !run.runId || run.reconciling) return Promise.resolve();
    run.reconciling = true;
    var note = reason || '';

    function attempt(i) {
      if (!isCurrentRun(run)) return;
      if (i >= RECONCILE_DELAYS.length) {
        run.reconciling = false;
        markUncertain(run, note || '多轮核对后 Hermes 仍未报告终态');
        return;
      }
      return delay(RECONCILE_DELAYS[i]).then(function () {
        if (!isCurrentRun(run)) return null;
        return fetchRunState(run);
      }).then(function (result) {
        if (!result || !isCurrentRun(run)) return;
        if (result.handled) { run.reconciling = false; return; }
        if (result.terminal) {
          run.reconciling = false;
          addEvent('RUN ⇄', result.terminal === 'completed' ? 'ok' : 'warn',
            'Hermes 权威状态：' + result.terminal, run.runId);
          if (result.body && result.body.output != null) {
            // 事件流即使已经送过部分 delta，也要用 Hermes 的权威完整输出覆盖。
            replaceOutput(result.body.output, run);
            run.started = true;
            run.outputComplete = true;
          }
          setStatus(result.terminal === 'completed' ? 'ok' : 'warn',
            result.terminal === 'completed'
              ? '事件流虽然断了，但已向 Hermes 核对：这次运行确实已完成。'
              : 'Hermes 核对结果：运行' + (result.terminal === 'failed' ? '失败' : '已取消')
                + '，这一轮不写入会话历史。', run);
          applyTerminal(run, result.terminal);
          return;
        }
        note = result.error || note;
        return attempt(i + 1);
      });
    }

    return Promise.resolve().then(function () { return attempt(0); });
  }

  /** 事件流结束后的收口。没拿到终态事件就必须去问权威状态，不许本地宣布完成。 */
  function finalizeRun(run, reason) {
    if (!isCurrentRun(run)) return Promise.resolve();
    endOutput(run);
    if (run.terminal) return Promise.resolve();
    setOutMeta('核对中', run);
    setConn('busy', '核对中');
    setStatus('warn', '事件流已结束但没有收到终态事件（' + truncate(reason, 120)
      + '）。正在向 Hermes 核对 run ' + run.runId + ' 的权威状态；未确认前不会宣布完成。', run);
    return reconcileRun(run, reason);
  }

  function submitTask(text) {
    // 按钮的 disabled 只是外观；真正的闸门在这里，「回车 + 点击」也绕不过去。
    if (state.submitting || !canSendNow(state)) return;
    var task = String(text || '').trim();
    if (!task) return;

    var controller = new AbortController();
    // run 就是这次运行的身份证：generation + controller 一起决定「它还是不是当前运行」。
    var run = {
      generation: state.generation,
      controller: controller,
      runId: null,
      task: task,
      turnId: null,
      text: '',
      started: false,
      terminal: null,
      outputCapped: false,
      outputComplete: false,
      persisted: false,
      reconciling: false
    };

    state.submitting = true;
    state.running = true;
    state.uncertain = false;
    state.controller = controller;
    state.activeRun = run;
    state.runId = null;

    dom.btnSend.disabled = true;
    dom.btnStop.disabled = true;   // run_id 未知前停不了，按钮如实反映
    dom.btnNew.disabled = true;
    dom.input.value = '';
    dom.hint.textContent = '提交中…';
    setConn('busy', '运行中');

    // 新的一轮：建记录、进 tasks 列表、自动选中并接管主画布。
    run.turnId = addTask(task);
    addEvent('RUN ▸', null, '提交任务', truncate(task, 120));

    var payload = {
      input: task,
      session_id: sessionId(),
      instructions: CFG.instructions,
      conversation_history: capHistory(state.history, CFG.history)
    };

    apiFetch('/v1/runs', {
      method: 'POST',
      json: payload,
      timeout: TIMEOUTS.createRun || 20000,
      signal: controller.signal
    }).then(function (res) {
      if (!isCurrentRun(run)) throw abandoned();
      if (res.status === 401) { handleUnauthorized(run.generation); throw abandoned(); }
      if (!res.ok) throw new Error(describeHttpError(res.status));
      return res.json();
    }).then(function (body) {
      if (!isCurrentRun(run)) throw abandoned();
      var runId = body && body.run_id;
      if (!runId) throw new Error('Hermes 没有返回 run_id。');
      run.runId = String(runId);
      state.runId = run.runId;   // 一旦知道就留着：异常路径也不清，否则就成了孤儿运行
      state.submitting = false;
      dom.btnStop.disabled = false;
      dom.hint.textContent = '运行中 · ' + truncate(run.runId, 22);
      addEvent('RUN', null, '已受理', run.runId);
      // 受理 ≠ 完成：历史只在权威 run.completed 之后成对写入。
      return streamRun(run);
    }).catch(function (err) {
      if (err && err.abandoned) return;
      if (!isCurrentRun(run)) return;
      var aborted = err && err.name === 'AbortError';
      var msg = aborted ? '提交已中止。' : errorText(err);
      markTask(run.turnId, aborted ? 'cancelled' : 'failed');
      addEvent('RUN ✗', 'err', '提交失败', truncate(msg, 200));
      setOutMeta('失败', run);
      setConn('err', '连接异常');
      if (run.runId) {
        // 已经拿到 id：交给核对流程，不本地宣布结束。
        finalizeRun(run, msg);
        return;
      }
      // 从未拿到 run_id：请求可能压根没到 Hermes，也可能 run 已建好而响应在回程丢了。
      // 没有 id 就既停不掉也查不到 —— 只能如实说明，不能假装什么都没发生。
      setStatus('err', msg + ' 由于始终没有拿到 run_id，本页无法确认 Hermes 是否已经'
        + '建立了这次运行；如担心留下无人认领的运行，请到 Hermes 端直接查看 /v1/runs。', run);
      releaseRun(run);
    });
  }

  function streamRun(run) {
    var parser = createSseParser({ maxFrameChars: MAX_SSE_FRAME_CHARS });

    return apiFetch('/v1/runs/' + encodeURIComponent(run.runId) + '/events', {
      accept: 'text/event-stream',
      signal: run.controller.signal
    }).then(function (res) {
      if (!isCurrentRun(run)) throw abandoned();
      if (res.status === 401) { handleUnauthorized(run.generation); throw abandoned(); }
      if (!res.ok) throw new Error(describeHttpError(res.status));

      // 读之前先验 Content-Type：反代登录页、错误 HTML 也可能带 200 回来。
      var ctype = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('Content-Type') : '';
      if (!isEventStreamContentType(ctype)) {
        throw new Error('事件流返回的不是 text/event-stream（'
          + (truncate(ctype, 60) || '缺少 Content-Type') + '），已拒绝按 SSE 解析。');
      }

      // 无 ReadableStream 的老浏览器：退化成一次性读取，仍然能拿到完整结果。
      if (!res.body || typeof res.body.getReader !== 'function') {
        return res.text().then(function (all) {
          var events = parser.push(all);
          for (var i = 0; i < events.length; i++) handleEvent(events[i], run);
          var tail = parser.flush();
          for (var j = 0; j < tail.length; j++) handleEvent(tail[j], run);
        });
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');

      function pump() {
        return reader.read().then(function (chunk) {
          if (!isCurrentRun(run)) {
            try { reader.cancel(); } catch (e) { /* noop */ }
            return;
          }
          if (chunk.done) {
            var tail = parser.flush();
            for (var k = 0; k < tail.length; k++) handleEvent(tail[k], run);
            return;
          }
          var events = parser.push(decoder.decode(chunk.value, { stream: true }));
          for (var i = 0; i < events.length; i++) handleEvent(events[i], run);
          return pump();
        });
      }
      return pump();
    }).then(function () {
      return finalizeRun(run, '事件流已正常结束');
    }, function (err) {
      if (err && err.abandoned) return;
      if (!isCurrentRun(run)) return;
      var msg = err && err.name === 'AbortError' ? '事件流被本地中止' : errorText(err);
      addEvent('STREAM ✗', 'err', '事件流中断', truncate(msg, 200));
      // 流断了什么都不证明：终态一律回 Hermes 核对。
      return finalizeRun(run, msg);
    });
  }

  function stopRun() {
    var run = state.activeRun;
    if (!run || !run.runId || !isCurrentRun(run)) return;
    dom.btnStop.disabled = true;
    dom.hint.textContent = '正在停止…';
    addEvent('RUN ⏹', 'warn', '已请求停止', truncate(run.runId, 22));

    apiFetch('/v1/runs/' + encodeURIComponent(run.runId) + '/stop', {
      method: 'POST',
      json: {},
      timeout: TIMEOUTS.stopRun || 10000
    }).then(function (res) {
      if (!isCurrentRun(run)) return;
      if (res.status === 401) { handleUnauthorized(run.generation); return; }
      if (!res.ok) {
        // 停止被拒绝：远端极可能还在跑。绝不能清本地状态假装停住了。
        var why = describeHttpError(res.status);
        addEvent('RUN ⏹', 'err', '停止请求被拒绝', truncate(why, 200));
        setStatus('err', '停止请求被拒绝（' + why + '）。运行可能仍在 Hermes 上继续，'
          + '运行 ID ' + run.runId + ' 已保留，可以再点一次「停止」重试。', run);
        dom.btnStop.disabled = false;
        return;
      }
      addEvent('RUN ⏹', 'warn', 'Hermes 已受理停止请求', '正在核对终态…');
      setStatus('warn', '停止请求已受理，正在向 Hermes 核对最终状态；'
        + '在看到权威终态之前不会宣布已停止。', run);
      return reconcileRun(run, '停止请求已受理，但尚未看到终态');
    }, function (err) {
      if (!isCurrentRun(run)) return;
      // 传输失败 ⇒ 服务端是否收到不可证明，同样不许本地宣布结束。
      var msg = describeNetworkError(err, CFG.apiBase);
      addEvent('RUN ⏹', 'err', '停止请求发送失败', truncate(msg, 200));
      setStatus('err', '停止请求没能送达（' + msg + '）。无法确认 Hermes 是否已经停下，'
        + '运行 ID ' + run.runId + ' 已保留，可以再点一次「停止」重试。', run);
      dom.btnStop.disabled = false;
    });
  }

  /* ── 凭据：换令牌 + 复验，失败即关门 ── */
  /**
   * 用主口令换一枚设备令牌。这是主口令唯一一次离开输入框：
   * 只进请求体、只发这一次，响应回来立刻被调用方置空。
   * 这一发刻意不带 Authorization —— 那时候还没有任何令牌可带。
   */
  function loginWithMasterKey(candidate) {
    return apiFetch('/v1/console/auth/login', {
      method: 'POST',
      json: { key: candidate },
      anonymous: true,
      timeout: TIMEOUTS.login || 15000
    }).then(function (res) {
      if (res.status === 429) {
        return { ok: false, message: '失败次数过多，Hermes 已暂时拒绝登录，请过一会儿再试。' };
      }
      if (!res.ok) return { ok: false, message: describeHttpError(res.status) };
      return res.json().then(function (body) {
        var token = body && body.device_token;
        if (typeof token !== 'string' || token.length < 32) {
          return { ok: false, message: 'Hermes 没有返回可用的设备令牌，已拒绝解锁。' };
        }
        return { ok: true, token: token };
      }, function () {
        return { ok: false, message: '登录响应无法解析成 JSON，已拒绝解锁。' };
      });
    }, function (err) {
      return { ok: false, message: describeNetworkError(err, CFG.apiBase), offline: true };
    });
  }

  /**
   * 拿一枚设备令牌去问 /v1/capabilities。只有两件事同时成立才算通过：
   *   · HTTP 2xx（令牌本身被接受）；
   *   · 响应体里 data.auth.required === true（网关自述「我在校验鉴权」）。
   * 缺字段、false、结构不对、JSON 读不出来 —— 一律拒绝解锁并解释清楚为什么危险。
   */
  function verifyToken(token) {
    return apiFetch('/v1/capabilities', {
      token: token,
      timeout: TIMEOUTS.capabilities || 12000
    }).then(function (res) {
      // 401 是唯一能证明「这枚令牌确实作废了」的回答。403（CORS 没放行）、
      // 5xx、离线都只说明这一刻问不到 —— 拿它们当删除本地令牌的依据，
      // 等于每次网关抽风都逼人重输一次主口令。
      if (res.status === 401) {
        return { ok: false, unauthorized: true, message: describeHttpError(401) };
      }
      if (!res.ok) return { ok: false, message: describeHttpError(res.status) };
      return res.json().then(function (data) {
        if (!capabilitiesAuthEnforced(data)) {
          return { ok: false, insecure: true, message: AUTH_NOT_ENFORCED_WARNING };
        }
        return { ok: true, data: data };
      }, function () {
        return { ok: false, insecure: true, message: CAPABILITIES_UNREADABLE_WARNING };
      });
    }, function (err) {
      return { ok: false, message: describeNetworkError(err, CFG.apiBase), offline: true };
    });
  }

  /* ── 历史会话抽屉 ─────────────────────────────────────────────
     列表与详情都来自 Hermes 的 /v1/console/sessions*。本页不缓存、不落盘，
     只把服务端给的最小投影渲染成文本节点。工具数据在服务端就已经被滤掉了，
     这里再挡一次（见 parseConsoleSessionDetail）。
     ───────────────────────────────────────────────────────────── */

  function setHistoryState(tone, text) {
    if (!text) {
      dom.historyState.hidden = true;
      dom.historyState.textContent = '';
      dom.historyState.removeAttribute('data-tone');
      return;
    }
    dom.historyState.textContent = text;
    if (tone) dom.historyState.setAttribute('data-tone', tone);
    else dom.historyState.removeAttribute('data-tone');
    dom.historyState.hidden = false;
  }

  function historyFocusables() {
    return dom.historyPanel.querySelectorAll('button:not([disabled])');
  }

  function openHistoryDialog() {
    if (!state.unlocked || state.historyOpen) return;
    state.historyOpen = true;
    state.historyReturnFocus = document.activeElement;
    dom.historyDialog.hidden = false;
    dom.body.classList.add('is-history-open');
    [document.querySelector('.topbar'), dom.workbench, dom.composer].forEach(function (node) {
      if (node) node.inert = true;
    });
    dom.btnHistory.setAttribute('aria-expanded', 'true');
    try { dom.historyClose.focus(); } catch (e) { /* noop */ }
    loadServerSessions();
  }

  function closeHistoryDialog() {
    if (!state.historyOpen) return;
    state.historyOpen = false;
    dom.historyDialog.hidden = true;
    dom.body.classList.remove('is-history-open');
    [document.querySelector('.topbar'), dom.workbench, dom.composer].forEach(function (node) {
      if (node) node.inert = false;
    });
    dom.btnHistory.setAttribute('aria-expanded', 'false');
    var back = state.historyReturnFocus;
    state.historyReturnFocus = null;
    if (back && back.focus) { try { back.focus(); } catch (e) { /* noop */ } }
  }

  /** 模态对话框的键盘契约：Esc 关闭，Tab 原地打转，不许跑到被遮住的工作台上。 */
  function onHistoryKeydown(e) {
    if (!state.historyOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeHistoryDialog(); return; }
    if (e.key !== 'Tab') return;
    var items = historyFocusables();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function renderSessionList(rows) {
    clear(dom.historyList);
    if (!rows.length) {
      setHistoryState('', '还没有服务端会话。发一条指令，这一场对话就会出现在这里。');
      return;
    }
    setHistoryState('', '');
    // 服务端列表给的是逻辑根；拿物理会话 id 去比，压缩之后「当前」就永远点不亮了。
    var current = state.logicalSessionId;
    rows.forEach(function (row) {
      var li = document.createElement('li');
      var btn = el('button', 'hs-btn');
      btn.type = 'button';
      var isCurrent = row.sessionId === current;
      if (isCurrent) btn.setAttribute('aria-current', 'true');
      var top = el('span', 'hs-top');
      top.appendChild(el('span', 'hs-time', formatSessionTime(row.lastActive) || '—'));
      top.appendChild(el('span', 'hs-count', row.messageCount + ' 条'));
      if (isCurrent) top.appendChild(el('span', 'hs-now', '当前'));
      btn.appendChild(top);
      // 关键：预览来自用户输入与模型输出，只能走文本节点。
      btn.appendChild(el('span', 'hs-preview',
        truncate(row.preview, PREVIEW_CHARS) || '（没有可预览的内容）'));
      btn.setAttribute('aria-label',
        '载入会话：' + (truncate(row.preview, 40) || row.sessionId));
      btn.addEventListener('click', function () { selectServerSession(row.sessionId); });
      li.appendChild(btn);
      dom.historyList.appendChild(li);
    });
  }

  function loadServerSessions() {
    var generation = state.generation;
    setHistoryState('', '正在读取服务端会话…');
    clear(dom.historyList);
    return apiFetch('/v1/console/sessions', {
      timeout: TIMEOUTS.sessions || 12000
    }).then(function (res) {
      if (!isCurrentGeneration(generation)) return;
      if (res.status === 401) { handleUnauthorized(generation); return; }
      if (!res.ok) { setHistoryState('err', describeHttpError(res.status)); return; }
      return res.json().then(function (body) {
        if (!isCurrentGeneration(generation)) return;
        renderSessionList(parseConsoleSessions(body, SESSION_LIMIT));
      }, function () {
        setHistoryState('err', '会话列表响应无法解析成 JSON。');
      });
    }, function (err) {
      if (!isCurrentGeneration(generation)) return;
      setHistoryState('err', describeNetworkError(err, CFG.apiBase));
    });
  }

  /**
   * 载入一场服务端会话。三道门禁缺一不可：
   *   · 运行中一律拒绝 —— 换掉在途 run 的画布会让人分不清哪一轮是哪一轮；
   *   · generation —— 换过口令 / 重新解锁之后，旧请求的响应不许落地；
   *   · hydrationSeq —— 连点两条时晚发起的赢，早的那次安静退场。
   */
  function selectServerSession(id) {
    // 解析成 {ok, missing}：404（那一场真的没了）与「这一刻问不到网关」必须
    // 分得开 —— 只有前者才该抹掉本机记住的那个 id。
    var gone = { ok: false, missing: true };
    var unavailable = { ok: false, missing: false };
    if (!isConsoleSessionId(id) || !state.unlocked) return Promise.resolve(unavailable);
    if (state.running) {
      setHistoryState('warn', '当前还有未确认结束的运行；先等它收尾或点「停止」，再切换会话。');
      return Promise.resolve(unavailable);
    }
    var generation = state.generation;
    state.hydrationSeq += 1;
    var stamp = state.hydrationSeq;
    setHistoryState('', '正在载入会话…');
    return apiFetch('/v1/console/sessions/' + encodeURIComponent(id), {
      timeout: TIMEOUTS.sessionDetail || 15000
    }).then(function (res) {
      if (!isCurrentGeneration(generation) || stamp !== state.hydrationSeq) return unavailable;
      if (res.status === 401) { handleUnauthorized(generation); return unavailable; }
      if (res.status === 404) { setHistoryState('err', describeHttpError(404)); return gone; }
      if (!res.ok) { setHistoryState('err', describeHttpError(res.status)); return unavailable; }
      return res.json().then(function (body) {
        if (!isCurrentGeneration(generation) || stamp !== state.hydrationSeq
            || state.running || state.submitting) return unavailable;
        var detail = parseConsoleSessionDetail(body);
        if (!detail) {
          setHistoryState('err', '会话详情无法解析，已保持当前会话不变。');
          return unavailable;
        }
        if (!isCurrentGeneration(generation) || stamp !== state.hydrationSeq
            || state.running || state.submitting) return unavailable;
        applyServerSession(detail);
        return { ok: true, missing: false };
      }, function () {
        setHistoryState('err', '会话详情响应无法解析成 JSON。');
        return unavailable;
      });
    }, function (err) {
      if (!isCurrentGeneration(generation) || stamp !== state.hydrationSeq) return unavailable;
      setHistoryState('err', describeNetworkError(err, CFG.apiBase));
      return unavailable;
    });
  }

  /** 把一对已完成的问答还原成一轮。历史轮次是终态，不参与任何 run 生命周期。 */
  function restoreTurn(task, output) {
    var id = addTask(task);
    var turn = state.turns[id];
    if (!turn) return id;
    turn.text = String(output == null ? '' : output).slice(0, MAX_OUTPUT_CHARS);
    turn.started = true;
    turn.live = false;
    turn.status = 'done';
    turn.outMeta = '已完成 · 历史';
    if (turn.btn) turn.btn.setAttribute('data-state', 'done');
    return id;
  }

  /** 用服务端历史重建本地视图：左栏任务列表 + 主画布，全部来自完成的一问一答。 */
  function applyServerSession(detail) {
    clearCanvas();
    setSessionId(detail.sessionId, detail.currentSessionId);
    state.history = capHistory(detail.messages, CFG.history);
    var pairs = historyPairs(detail.messages);
    var lastId = null;
    for (var i = 0; i < pairs.length; i++) {
      lastId = restoreTurn(pairs[i].task, pairs[i].output);
    }
    if (lastId != null) selectTurn(lastId);
    // 采纳新身份后闸门可能刚被解开（例如上一场的指针核对失败过），按钮要跟上。
    setEnabled(state.unlocked);
    closeHistoryDialog();
    addEvent('SESSION', 'ok', '已载入服务端会话',
      detail.sessionId + ' · ' + pairs.length + ' 轮');
  }

  /**
   * 解锁之后决定「现在该看哪一场会话」，三层退路，缺一层就会有人看到空白页：
   *   1. 本机记得一个形状合法的**逻辑根** → 真的去拉它的详情并载入。只把 id
   *      抄进 state 是不够的：那样同机刷新之后画布是空的，而下一轮还会被
   *      追加进那一场，等于历史凭空少了一截；
   *   2. 那一场已经不在了（404）→ 忘掉它，改拉服务端最新一场；
   *   3. 还是不行 → 开一场全新会话，不打扰用户。
   */
  function hydrateFromServer(generation) {
    state.hydrating = true;
    setEnabled(state.unlocked);
    var remembered = rememberedSessionId();
    var work = remembered ? selectServerSession(remembered) : autoLoadLatestSession(generation);
    return work.then(function (result) {
      if (!isCurrentGeneration(generation)) return null;
      if (!remembered || (result && result.ok)) return true;
      // 只有 404 才说明那一场真的没了；连不上不该抹掉本机记忆。
      if (result && result.missing) {
        forgetRememberedSessionId();
        return autoLoadLatestSession(generation);
      }
      state.pointerBroken = true;
      return false;
    }).then(function (result) {
      if (isCurrentGeneration(generation)) {
        state.hydrating = false;
        setEnabled(state.unlocked);
      }
      return result;
    });
  }

  function autoLoadLatestSession(generation) {
    return apiFetch('/v1/console/sessions?limit=1', {
      timeout: TIMEOUTS.sessions || 12000
    }).then(function (res) {
      if (!isCurrentGeneration(generation)) return;
      if (res.status === 401) { handleUnauthorized(generation); return; }
      if (!res.ok) return;
      return res.json().then(function (body) {
        if (!isCurrentGeneration(generation)) return;
        var rows = parseConsoleSessions(body, 1);
        if (!rows.length) return;
        return selectServerSession(rows[0].sessionId);
      }, function () { /* 读不出来就用一个全新会话，不打扰用户 */ });
    }, function () { /* 拉不到列表同理：静默退到新会话 */ })
      .then(function () {
        if (isCurrentGeneration(generation) && !rememberedSessionId()) sessionId();
      });
  }

  /**
   * 另一个标签页把这台设备的令牌撤了 / 换了。内存里那一枚还在，但它已经不是
   * 这台设备的凭据了 —— 先用它尽力停掉在途运行，然后本页立刻收摊。
   *
   * 只丢内存里那一份：存储里现在躺着的可能是对方刚写进去的新令牌，删它等于
   * 顺手把那个标签页也踢下线。令牌本身不进日志、不进 DOM、不进任何提示文案。
   */
  function onDeviceTokenStorageChange(e) {
    if (!state.unlocked) return;
    // e.key === null 表示对方把整个存储清空了，那同样波及这把键。
    if (e && e.key != null && e.key !== STORE.deviceToken) return;
    var stored = loadDeviceToken();
    if (stored && state.token && stored === state.token) return;
    var displaced = state.token;
    // 顺序有意为之：stop 要赶在内存里那枚令牌被清掉之前发出去。
    bestEffortStopActiveRun();
    bestEffortLogout(displaced);
    abortRun('已锁定');
    forgetDeviceTokenInMemory();
    clearLocalHistory();
    forgetSessionIdentity();
    closeHistoryDialog();
    clearCanvas();
    showGate('另一个标签页移除或更换了这台设备的令牌，本页已锁定。'
      + '服务端的历史会话不受影响。');
  }

  /* ── 装配 ── */
  function renderQuickActions() {
    var actions = Array.isArray(CFG.quickActions) ? CFG.quickActions : [];
    clear(dom.qaList);
    actions.forEach(function (action) {
      var li = document.createElement('li');
      var btn = el('button', 'qa-btn');
      btn.type = 'button';
      btn.disabled = true;
      btn.appendChild(el('span', 'qa-label', action.label));
      if (action.hint) btn.appendChild(el('span', 'qa-hint', action.hint));
      btn.setAttribute('aria-label', action.label + '：把只读调研提示词填入输入框');
      btn.addEventListener('click', function () {
        // 只填充，不自动发送 —— 快捷任务永远需要人再按一次发送。
        dom.input.value = action.prompt;
        dom.input.focus();
        try {
          dom.input.setSelectionRange(action.prompt.length, action.prompt.length);
        } catch (e) { /* noop */ }
      });
      li.appendChild(btn);
      dom.qaList.appendChild(li);
    });
  }

  /* ── 输入区常驻底边 ──────────────────────────────────────────
     .composer 是 fixed 的，脱离文档流；正文靠 body 的 padding-bottom 让位。
     两边必须同高，否则要么压住最后一段内容、要么底部空一大块 —— 所以高度
     不写死，而是实测后写回 --composer-h（CSS 里的常量只是 JS 跑起来前的兜底）。
     ───────────────────────────────────────────────────────────── */
  function syncComposerHeight() {
    if (!dom.composer) return;
    var h = dom.composer.offsetHeight;
    if (!(h > 0)) return;
    document.documentElement.style.setProperty('--composer-h', h + 'px');
  }

  function watchComposerHeight() {
    syncComposerHeight();
    global.addEventListener('resize', syncComposerHeight);
    if (typeof global.ResizeObserver === 'function') {
      // textarea 被手动拉伸不会触发 window resize，只有观察元素本身才追得上。
      new global.ResizeObserver(syncComposerHeight).observe(dom.composer);
    } else {
      // 没有 ResizeObserver 时退而求其次：输入与拖拽结束后各补一次实测。
      dom.input.addEventListener('input', syncComposerHeight);
      dom.input.addEventListener('mouseup', syncComposerHeight);
      dom.input.addEventListener('touchend', syncComposerHeight);
    }
  }

  /* 窄屏默认收起两侧栏，让主画布优先；用户随时可以展开。 */
  function collapseRailsOnNarrowScreens() {
    if (!global.matchMedia || !global.matchMedia('(max-width: 860px)').matches) return;
    ['rail-actions', 'rail-history', 'rail-activity'].forEach(function (id) {
      var block = $(id);
      if (block) block.open = false;
    });
  }

  function boot() {
    var endpointLabel = CFG.apiBase || '(未配置)';
    dom.gateEndpoint.textContent = endpointLabel;
    dom.gateScope.textContent = CFG.sessionKey || '(未配置)';
    renderQuickActions();
    clearCanvas();
    collapseRailsOnNarrowScreens();
    watchComposerHeight();
    showGate('');

    dom.gateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var candidate = dom.gateKey.value;
      if (!candidate) return;
      // 主口令一进 JS 就从 DOM 里抹掉，免得它继续躺在输入框里。
      dom.gateKey.value = '';
      // 每次校验都领一个 generation：更晚发起的那次一旦落地，早先那次的迟到回调
      // 就再也解不开锁、清不掉凭据、也覆盖不了新状态。
      var generation = nextGeneration();
      dom.gateSubmit.disabled = true;
      dom.gateSubmit.textContent = '验证中…';
      dom.gateState.textContent = '正在换取设备令牌…';
      dom.gateErr.hidden = true;

      function reject(result) {
        dom.gateSubmit.disabled = false;
        dom.gateSubmit.textContent = '解锁工作台';
        dom.gateState.textContent = result.offline ? '网关不可达'
          : (result.insecure ? '网关未开启鉴权' : '验证失败');
        dom.gateErr.textContent = result.message;
        dom.gateErr.hidden = false;
        try { dom.gateKey.focus(); } catch (focusErr) { /* noop */ }
      }

      loginWithMasterKey(candidate).then(function (login) {
        // 主口令的使命到此为止：换到令牌也好、失败也好，都不再留在内存里。
        candidate = null;
        if (!isCurrentGeneration(generation)) return;
        if (!login.ok) { reject(login); return; }
        dom.gateState.textContent = '正在核对网关鉴权…';
        return verifyToken(login.token).then(function (result) {
          if (!isCurrentGeneration(generation)) return;
          if (!result.ok) {
            // 拿到了令牌却不敢用（网关自述没开鉴权）：顺手撤销，别留活口。
            bestEffortLogout(login.token);
            reject(result);
            return;
          }
          saveDeviceToken(login.token);
          clearLocalHistory();
          dom.gateState.textContent = '已通过';
          unlock();
          addEvent('AUTH ✓', 'ok', '已换取设备令牌，且 Hermes 自述已开启鉴权',
            truncate(endpointLabel, 60));
          hydrateFromServer(generation);
        });
      });
    });

    dom.form.addEventListener('submit', function (e) {
      e.preventDefault();
      submitTask(dom.input.value);
    });

    dom.input.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitTask(dom.input.value);
      }
    });

    dom.btnStop.addEventListener('click', stopRun);
    dom.btnLock.addEventListener('click', lockNow);
    dom.btnHistory.addEventListener('click', function () {
      if (state.historyOpen) closeHistoryDialog();
      else openHistoryDialog();
    });
    dom.historyClose.addEventListener('click', closeHistoryDialog);
    dom.historyDialog.addEventListener('click', function (e) {
      // 点遮罩关闭；点面板内部不关。
      if (e.target === dom.historyDialog) closeHistoryDialog();
    });
    document.addEventListener('keydown', onHistoryKeydown);
    dom.btnNew.addEventListener('click', function () {
      // 运行未确认结束前不许开新会话（按钮本身也是禁用的，这里再兜一次底）。
      if (state.running) return;
      abortRun('已开启新会话');
      clearLocalHistory();
      newSessionId();
      closeHistoryDialog();
      clearCanvas();
      dom.input.value = '';
      dom.input.focus();
      // 新会话要等第一次运行之后才会出现在服务端列表里 —— 这是刻意的。
      addEvent('SESSION', null, '已开启新会话', sessionId());
    });

    global.addEventListener('storage', onDeviceTokenStorageChange);

    global.addEventListener('online', function () {
      if (state.unlocked && !state.running) setConn('ok', '已连接');
    });
    global.addEventListener('offline', function () { setConn('err', '离线'); });

    // 换标签页 / 重启浏览器之后，用已存的设备令牌复验一次；失败就老实回到闸门。
    var stored = loadDeviceToken();
    if (stored) {
      // 复验期间用户完全可能手输一份新口令；那次提交会抬升 generation，
      // 于是这条迟到回调必须彻底闭嘴：不解锁、不清凭据、不覆盖任何新状态。
      var bootGeneration = nextGeneration();
      dom.gateState.textContent = '正在复验设备令牌…';
      setConn('busy', '验证中');
      verifyToken(stored).then(function (result) {
        if (!isCurrentGeneration(bootGeneration)) { stored = null; return; }
        if (result.ok) {
          saveDeviceToken(stored);   // 验过才上岗：未验证的令牌不进 state
          stored = null;
          clearLocalHistory();
          dom.gateState.textContent = '已通过';
          unlock();
          addEvent('AUTH ✓', 'ok', '设备令牌仍有效，工作台已恢复',
            truncate(endpointLabel, 60));
          hydrateFromServer(bootGeneration);
        } else {
          stored = null;
          clearLocalHistory();
          if (result.unauthorized) {
            // 服务端明说这枚令牌不认了：删掉它，回闸门换一枚新的。
            // 只清本地 —— 服务端历史原封不动，重新解锁还能从「历史会话」找回来。
            dropDeviceToken();
            showGate(result.message + ' 服务端的历史会话不受影响。');
          } else {
            // 离线 / 5xx / CORS 没放行：这枚令牌很可能还是好的，留着等下次刷新。
            showGate(result.message
              + ' 本地设备令牌已保留：网络恢复后刷新页面即可自动重试。');
          }
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
