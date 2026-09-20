// 掷筊 · /random/blocks
// 纯前端：两枚筊杯各自用 crypto.getRandomValues 独立落定，不发任何网络请求。
// classify() 单独导出，供 Node 侧测试直接 import；DOM 初始化在文件末尾按环境守卫。

export const SIDES = ['yang', 'yin'];

export const RESULTS = {
  sheng: {
    key: 'sheng',
    name: '圣筊',
    tag: '一阳一阴 · 允',
    desc: '一平一凸。传统上视为肯定：所问之事得到应允。',
  },
  xiao: {
    key: 'xiao',
    name: '笑筊',
    tag: '两阳 · 笑而不答',
    desc: '两枚皆平面向上。传统上视为问题不清、时机未到，或不必再问。',
  },
  ku: {
    key: 'ku',
    name: '哭筊',
    tag: '两阴 · 否',
    desc: '两枚皆凸面向上。传统上视为否定：所问之事不获同意，或需另作打算。',
  },
};

const SIDE_LABEL = { yang: '平面 · 阳', yin: '凸面 · 阴' };

/**
 * 按两枚筊杯的朝向判定结果。
 * @param {'yang'|'yin'} left
 * @param {'yang'|'yin'} right
 * @returns {{key:string,name:string,tag:string,desc:string}}
 */
export function classify(left, right) {
  if (!SIDES.includes(left) || !SIDES.includes(right)) {
    throw new RangeError('side must be "yang" or "yin"');
  }
  if (left !== right) return RESULTS.sheng;
  return left === 'yang' ? RESULTS.xiao : RESULTS.ku;
}

/**
 * 用 Web Crypto 取一位随机比特决定单枚筊杯朝向；两枚各调一次，互不相关。
 * @param {Crypto} [cryptoObj]
 * @returns {'yang'|'yin'}
 */
export function randomSide(cryptoObj) {
  const c = cryptoObj || globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable');
  }
  const buf = new Uint8Array(1);
  c.getRandomValues(buf);
  return SIDES[buf[0] & 1];
}

// ---------- 掷筊时间线 ----------

export const ROLL_DURATION_MS = 2000;

function flip(side) {
  return side === 'yang' ? 'yin' : 'yang';
}

/**
 * 由最终朝向反推一条确定性的模拟时间线：抛起 → 多次翻面 → 左筊落定 → 右筊落定并揭示。
 * 中间帧只是演示画面，不是新的随机结果；最终帧与传入的最终朝向严格一致。
 * @param {'yang'|'yin'} finalLeft
 * @param {'yang'|'yin'} finalRight
 * @returns {{durationMs:number, frames:Array<{at:number,phase:string,left:string,right:string,reveal:boolean}>}}
 */
export function buildRollTimeline(finalLeft, finalRight) {
  if (!SIDES.includes(finalLeft) || !SIDES.includes(finalRight)) {
    throw new RangeError('side must be "yang" or "yin"');
  }
  const L = finalLeft;
  const R = finalRight;
  const l = flip(L);
  const r = flip(R);
  const frame = (at, phase, left, right, reveal = false) => ({ at, phase, left, right, reveal });
  return {
    durationMs: ROLL_DURATION_MS,
    frames: [
      frame(0, 'launch', l, r),
      frame(260, 'tumble', L, r),
      frame(480, 'tumble', l, R),
      frame(700, 'tumble', L, R),
      frame(900, 'tumble', l, r),
      frame(1100, 'tumble', L, r),
      frame(1320, 'land-left', L, R),
      frame(1540, 'land-left', L, r),
      frame(1640, 'land-right', L, R),
      frame(ROLL_DURATION_MS, 'land-right', L, R, true),
    ],
  };
}

// ---------- DOM ----------

function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function init(doc) {
  const stage = doc.querySelector('[data-roll-stage]');
  const readout = doc.querySelector('[aria-live="polite"]');
  const title = doc.getElementById('result-title');
  const tag = doc.querySelector('[data-result-tag]');
  const desc = doc.querySelector('[data-result-desc]');
  const counter = doc.querySelector('[data-roll-count]');
  const triggers = Array.from(doc.querySelectorAll('[data-roll-trigger]'));
  const blocks = {
    left: doc.querySelector('[data-block="left"]'),
    right: doc.querySelector('[data-block="right"]'),
  };
  if (!stage || !readout || !title || !blocks.left || !blocks.right) return;

  let rolling = false;
  let count = 0;

  function which(el) {
    return el.dataset.block === 'left' ? '左' : '右';
  }

  function setBlock(el, side) {
    el.dataset.side = side;
    const label = el.querySelector('[data-side-label]');
    if (label) label.textContent = SIDE_LABEL[side];
    el.setAttribute('aria-label', `${which(el)}筊：${SIDE_LABEL[side]}，点击掷筊`);
  }

  // 翻转中：只换可见面，文案与 aria-label 固定为「翻转中」，不逐帧刷新。
  function showFace(el, side) {
    el.dataset.side = side;
  }

  function setBlockState(el, state) {
    if (state) el.dataset.rollState = state;
    else delete el.dataset.rollState;
    const label = el.querySelector('[data-side-label]');
    if (state && state !== 'landed') {
      if (label) label.textContent = '翻转中';
      el.setAttribute('aria-label', `${which(el)}筊：翻转中`);
    }
  }

  function render(left, right) {
    const result = classify(left, right);
    setBlock(blocks.left, left);
    setBlock(blocks.right, right);
    readout.dataset.result = result.key;
    title.textContent = result.name;
    if (tag) tag.textContent = `第 ${count} 次 · ${result.tag}`;
    if (desc) desc.textContent = result.desc;
    if (counter) counter.textContent = String(count);
  }

  // 开始时宣告一次「掷筊中」，之后 aria-live 区域直到落定才再变化。
  function renderRolling() {
    delete readout.dataset.result;
    title.textContent = '掷筊中';
    if (tag) tag.textContent = `第 ${count + 1} 次 · 掷筊中`;
    if (desc) desc.textContent = '正在翻转 · 请稍候';
  }

  function applyFrame(f) {
    stage.dataset.rollPhase = f.phase;
    showFace(blocks.left, f.left);
    showFace(blocks.right, f.right);
    if (f.phase === 'launch') {
      setBlockState(blocks.left, 'launch');
      setBlockState(blocks.right, 'launch');
    } else if (f.phase === 'tumble') {
      setBlockState(blocks.left, 'tumble');
      setBlockState(blocks.right, 'tumble');
    } else if (f.phase === 'land-left') {
      // 左筊先落定并显示真实朝向，右筊继续翻转。
      setBlockState(blocks.left, 'landed');
      setBlock(blocks.left, f.left);
      setBlockState(blocks.right, 'tumble');
    } else if (f.phase === 'land-right') {
      setBlockState(blocks.right, 'landed');
      setBlock(blocks.right, f.right);
    }
  }

  function roll() {
    if (rolling) return;

    // 在改变交互状态前完成所有可能失败的随机数与时间线计算，避免异常时界面卡在「掷筊中」。
    const left = randomSide();
    const right = randomSide();
    const timeline = buildRollTimeline(left, right);

    rolling = true;
    triggers.forEach((b) => { b.disabled = true; });
    stage.classList.add('is-rolling');
    doc.body.classList.add('is-rolling');

    const settle = () => {
      count += 1;
      render(left, right);
      delete stage.dataset.rollPhase;
      setBlockState(blocks.left, null);
      setBlockState(blocks.right, null);
      stage.classList.remove('is-rolling');
      doc.body.classList.remove('is-rolling');
      triggers.forEach((b) => { b.disabled = false; });
      rolling = false;
    };

    if (prefersReducedMotion()) {
      settle();
      return;
    }

    renderRolling();
    timeline.frames.forEach((f) => {
      setTimeout(() => {
        applyFrame(f);
        if (f.reveal) settle();
      }, f.at);
    });
  }

  triggers.forEach((b) => b.addEventListener('click', roll));
}

// 仅在浏览器中挂载；Node 里 import 本文件只拿 classify 等纯函数。
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(document), { once: true });
  } else {
    init(document);
  }
}
