/* website/public/agent/config.js
 *
 * 小八 · AI 研究工作台 —— 非机密配置。
 *
 * ⚠️ 这个文件会随静态站一起公开发布。
 *    只放「知道了也没用」的配置：接口地址、会话作用域、UI 限额。
 *    绝对不要往这里写 API_SERVER_KEY / Bearer token / 任何口令。
 *
 * 凭据模型（两样东西，别混）：
 *    · 主口令 = Hermes 的 API_SERVER_KEY。使用者手输一次，POST 给
 *      /v1/console/auth/login 换成设备令牌，响应一到就丢弃，任何存储都不碰。
 *    · 设备令牌 = 服务端签发的不透明串，可撤销、默认 90 天到期。只有它进
 *      localStorage —— 所以关了标签页、重启浏览器，工作台仍然是激活的。
 */
(function (global) {
  'use strict';

  // runtime.json 由本机隧道守护进程更新。每次页面加载都带时间戳读取，
  // 避免 CloudBase CDN / 浏览器继续使用已经失效的临时隧道地址。
  // 仅接受 HTTPS 的 Tailscale 或 trycloudflare.com 地址，其他值忽略。
  var runtimeApiBase = '';
  if (typeof XMLHttpRequest !== 'undefined') {
    try {
      var runtimeRequest = new XMLHttpRequest();
      runtimeRequest.open('GET', './runtime.json?_=' + Date.now(), false);
      runtimeRequest.send(null);
      if (runtimeRequest.status >= 200 && runtimeRequest.status < 300) {
        var runtimeConfig = JSON.parse(runtimeRequest.responseText || '{}');
        var candidate = String(runtimeConfig.apiBase || '').replace(/\/$/, '');
        var allowedRuntime = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(candidate) ||
          candidate === 'https://yjjs-mac-mini.tail2151f3.ts.net:8443';
        if (allowedRuntime) runtimeApiBase = candidate;
      }
    } catch (_) {
      runtimeApiBase = '';
    }
  }

  var CONFIG = {
    // 首选 runtime.json 的当前隧道；读取失败时退回 Tailscale Funnel。
    apiBase: runtimeApiBase || 'https://yjjs-mac-mini.tail2151f3.ts.net:8443',

    // 长期记忆 / 审批作用域。稳定值，换了会丢上下文归属。
    sessionKeyHeader: 'X-Hermes-Session-Key',
    sessionKey: 'agent:main:web:briefs-agent:barry',

    // localStorage 键名。这里**只**放两样非口令的东西：
    //   · deviceToken：服务端签发、可撤销、有到期的设备令牌；
    //   · sessionId：会话的**逻辑根** id（形如 briefs-agent-<hex>，非机密）。
    //     刻意不存「当前物理会话 id」—— 上下文压缩会让 Hermes 换一个 id 继续写，
    //     把那个 id 腌进浏览器只会留下一个过期指针。
    // 主口令永远不进任何存储；会话历史的真相在服务端 SessionDB，也不落这里。
    storage: {
      deviceToken: 'barry_agent_device_token',
      sessionId: 'barry_agent_session_id'
    },

    // 客户端自管对话历史的防御性上限：只留最近 N 条 user/assistant，
    // 且总字符数封顶。工具输出一律不进历史。这份历史只活在内存里，
    // 仍然发给 Runs API 是为了兼容既有接口；跨设备恢复走服务端。
    history: {
      maxMessages: 20,
      maxChars: 24000,
      maxCharsPerMessage: 8000
    },

    // 「历史会话」抽屉的显示上限。服务端本身也封顶，这里只是再收一道。
    sessions: {
      maxItems: 30,
      previewChars: 90
    },

    // 单帧 / 单次运行输出的硬上限：SSE 对端异常时不至于把内存撑爆。
    maxSseFrameChars: 262144,
    maxOutputChars: 1048576,

    // 网络超时（毫秒）
    timeouts: {
      capabilities: 12000,
      login: 15000,
      logout: 8000,
      sessions: 12000,
      sessionDetail: 15000,
      createRun: 20000,
      stopRun: 10000,
      approval: 10000,
      runState: 10000
    },

    // 事件流断开后向 GET /v1/runs/{id} 核对权威终态的重试节奏（毫秒）。
    // 有界：轮完仍不确定就进入「状态未确认」，绝不本地宣布完成。
    reconcileDelays: [0, 1200, 2500, 4000, 6000],

    // 每轮收尾后向 /v1/console/sessions/{root} 核对「这一场现在写到哪个物理
    // 会话」的重试节奏（毫秒）。有界：问不出来就停用继续发送（新会话仍可用），
    // 绝不把下一轮追加到一段可能已被压缩结束的对话上。
    sessionPointerDelays: [0, 900, 2400],

    // 每次 run 附带的临时系统提示。非机密，讲清楚工作台的默认边界。
    instructions: [
      '你是 Barry 的研究助理「小八」，当前通过 barryai.cn 的只读研究工作台被调用。',
      '默认工作模式是只读调研：优先查看、汇总、解释，不要主动执行部署、删除、推送、改配置一类的写操作。',
      '确有必要做写操作时，先说明理由并等待人工审批，不要自行绕过。',
      '回答用中文，结构化输出：先给结论，再给依据，最后给可选的下一步。',
      '涉及行情与研报内容时说明这是研究参考，不构成投资建议。'
    ].join('\n'),

    // 左栏快捷任务：只读提示词，点一下只是填进输入框，不会自动发送。
    quickActions: [
      {
        id: 'daily-status',
        label: '今日产出体检',
        hint: '四档简报是否齐全',
        prompt: '只读检查「今天在涨啥」今天的产出情况：早间 / 午间 / 晚间 / 深夜四档简报分别有没有生成、生成时间和大致篇幅。只查看不修改，最后用表格汇总，并指出缺口。'
      },
      {
        id: 'site-health',
        label: '站点可用性自检',
        hint: 'briefs 线上巡检',
        prompt: '只读巡检 https://barryai.cn/briefs/ ：首页能否打开、briefs/index.json 覆盖了哪些日期、最近 7 天有没有断档。只读，不要执行任何部署或写操作，给出结论和缺口清单。'
      },
      {
        id: 'recent-failures',
        label: '最近失败与告警',
        hint: '日志里的异常项',
        prompt: '只读查看「今天在涨啥」最近几次运行的日志，列出其中的告警、重试和失败项，按严重度排序并推测原因。只读，不要改配置、不要重跑任务。'
      },
      {
        id: 'weekly-stats',
        label: '本周产出统计',
        hint: '7 天节奏与要点密度',
        prompt: '只读统计「今天在涨啥」最近 7 天的简报产出：每天各档是否有产出、平均要点条数、覆盖的市场。输出一张表加两句结论。不要写任何文件。'
      },
      {
        id: 'repo-diff',
        label: '仓库近期变更',
        hint: '最近提交做了什么',
        prompt: '只读查看「今天在涨啥」仓库最近 5 次提交，说明每次改了什么、影响哪个模块、有没有需要注意的风险。只用只读的 git 查询命令，不要 commit / push / checkout。'
      },
      {
        id: 'explain-signal',
        label: '解释一个信号',
        hint: '拿最新简报追问',
        prompt: '基于最新一期简报，挑出你认为最值得追问的一条 AI 相关信号，解释它的逻辑链条、受益与证伪条件。只做分析，不要执行任何命令。'
      }
    ]
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
  }
  global.BARRY_AGENT_CONFIG = CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
