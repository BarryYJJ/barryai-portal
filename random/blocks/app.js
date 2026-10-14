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

// 翻转层关键帧上的进度。同面再转一整圈，异面转半圈；相邻角度差小于 180°，避免插值走短路。
const SPIN_MARKS = [0, 0.28, 0.5, 0.78, 1];
// 与 styles.css 里 jiao-spin-l / jiao-spin-r 的百分比一致。过了最后一站就保持终态，回弹只平移。
const SPIN_STOPS = {
  left: [0, 0.14, 0.24, 0.36, 0.49],
  right: [0.12, 0.26, 0.36, 0.54, 0.72],
};

/**
 * 一次抛掷的翻转角。direction 取左正右负；不抽样、不模拟物理。
 * @param {'yang'|'yin'} start
 * @param {'yang'|'yin'} end
 * @param {number} direction
 * @returns {{direction:number, travel:number, angles:number[]}}
 */
export function tumblePlan(start, end, direction) {
  if (!SIDES.includes(start) || !SIDES.includes(end)) {
    throw new RangeError('side must be "yang" or "yin"');
  }
  const dir = direction < 0 ? -1 : 1;
  const travel = start === end ? 360 : 180;
  const origin = start === 'yin' ? 180 : 0;
  return {
    direction: dir,
    travel,
    angles: SPIN_MARKS.map((mark) => Math.round((origin + dir * travel * mark) * 10) / 10),
  };
}

/** rotateX 的正面：余弦为正是阳面朝上，为负是阴面朝上。 */
export function faceFromSpin(deg) {
  return Math.cos(deg * Math.PI / 180) >= 0 ? 'yang' : 'yin';
}

function spinAngleAt(angles, stops, t) {
  if (t <= stops[0]) return angles[0];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t <= stops[i + 1]) {
      const span = stops[i + 1] - stops[i];
      const u = span ? (t - stops[i]) / span : 1;
      return angles[i] + (angles[i + 1] - angles[i]) * u;
    }
  }
  return angles[angles.length - 1];
}

/**
 * 由起止朝向排一条确定性时间线：抛起、在各自转到侧面时换面、左筊先触台、右筊后触台并揭示。
 * 弧线在 CSS 里只播一次；这里的朝向跟着那次翻转的角度走，不再在固定时刻把两枚一起换色。
 * @param {'yang'|'yin'} finalLeft
 * @param {'yang'|'yin'} finalRight
 * @param {'yang'|'yin'} [startLeft]
 * @param {'yang'|'yin'} [startRight]
 * @returns {{durationMs:number, frames:Array<{at:number,phase:string,left:string,right:string,reveal:boolean}>}}
 */
export function buildRollTimeline(finalLeft, finalRight, startLeft = 'yang', startRight = 'yin') {
  if (![finalLeft, finalRight, startLeft, startRight].every((side) => SIDES.includes(side))) {
    throw new RangeError('side must be "yang" or "yin"');
  }
  const leftPlan = tumblePlan(startLeft, finalLeft, 1);
  const rightPlan = tumblePlan(startRight, finalRight, -1);
  const frame = (at, phase, reveal = false) => {
    const t = at / ROLL_DURATION_MS;
    return {
      at,
      phase,
      left: t >= SPIN_STOPS.left[SPIN_STOPS.left.length - 1]
        ? finalLeft
        : faceFromSpin(spinAngleAt(leftPlan.angles, SPIN_STOPS.left, t)),
      right: t >= SPIN_STOPS.right[SPIN_STOPS.right.length - 1]
        ? finalRight
        : faceFromSpin(spinAngleAt(rightPlan.angles, SPIN_STOPS.right, t)),
      reveal,
    };
  };
  return {
    durationMs: ROLL_DURATION_MS,
    frames: [
      frame(0, 'launch'),
      frame(260, 'tumble'),
      frame(480, 'tumble'),
      frame(700, 'tumble'),
      frame(900, 'tumble'),
      frame(1000, 'land-left'),
      frame(1240, 'land-left'),
      frame(1480, 'land-right'),
      frame(ROLL_DURATION_MS, 'land-right', true),
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

  // 选定这一次的翻转关键帧。必须在加上 .is-rolling 之前，动画名中途不能再改。
  function armSpin(el, start, end) {
    el.dataset.spin = `${start}-${end}`;
  }

  // 阶段只驱动文案和可见面。抛掷轨迹挂在 .is-rolling 上，不能按阶段重启动画。
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
    const startLeft = blocks.left.dataset.side;
    const startRight = blocks.right.dataset.side;
    const timeline = buildRollTimeline(left, right, startLeft, startRight);

    rolling = true;
    triggers.forEach((b) => { b.disabled = true; });
    armSpin(blocks.left, startLeft, left);
    armSpin(blocks.right, startRight, right);
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
      delete blocks.left.dataset.spin;
      delete blocks.right.dataset.spin;
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
