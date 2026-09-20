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

// ---------- DOM ----------

function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function rollDurationMs(root) {
  if (prefersReducedMotion()) return 0;
  const raw = getComputedStyle(root).getPropertyValue('--roll-ms').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 720;
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

  function setBlock(el, side) {
    el.dataset.side = side;
    const label = el.querySelector('[data-side-label]');
    if (label) label.textContent = SIDE_LABEL[side];
    const which = el.dataset.block === 'left' ? '左' : '右';
    el.setAttribute('aria-label', `${which}筊：${SIDE_LABEL[side]}，点击掷筊`);
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

  function roll() {
    if (rolling) return;
    rolling = true;
    triggers.forEach((b) => { b.disabled = true; });
    stage.classList.add('is-rolling');
    doc.body.classList.add('is-rolling');

    // 先取随机，再等动画落定后揭示，保证结果不受动画时长影响。
    const left = randomSide();
    const right = randomSide();
    const wait = rollDurationMs(doc.documentElement);

    const settle = () => {
      count += 1;
      render(left, right);
      stage.classList.remove('is-rolling');
      doc.body.classList.remove('is-rolling');
      triggers.forEach((b) => { b.disabled = false; });
      rolling = false;
    };
    if (wait === 0) settle();
    else setTimeout(settle, wait);
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
