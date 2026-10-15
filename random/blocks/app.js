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

// ---------- 掷筊运动 ----------
// 俯视台面：地面与镜头都不动。筊杯在台面平面上横移、绕竖轴（Z）转，离地高度只体现为向镜头放大和地面影子变虚变淡。
// 翻滚绕筊杯平面内的一根轴：贴近 X 是翻跟头，贴近 Y 是侧滚，斜着就是 X、Y 两轴一起转；空中 Z 角还在转，
// 这根轴在地面上也跟着转。落定时翻过整数个半圈，静止姿态记成 rotate(yaw) · rotateX(rx) · rotateY(ry)，rx/ry 为 0 或 180。
// 阴阳在 roll() 里先由 randomSide 定好，这里只照着它排画面；画面的随机性另由 motionSeed 取一个种子展开。

export const ROLL_DURATION_MS = 2000;

const TUMBLE_AT = 100;      // 出手之后进入翻滚阶段
const FRAME_STEP_MS = 20;   // WAAPI 关键帧采样间隔；之间线性插值
const SLIDE_MS = 380;       // 触地后滑行、Z 角余转
const ROCK_MS = 460;        // 触地后摇晃衰减到停稳
const HOPS_MS = [220, 110]; // 触地后两次回弹
// 筊杯图形相对 .jiao 宽度的半宽 / 半长：viewBox 120×200，绕 (48,100) 转，含阳面侧壁
const CUP_HALF = [0.36, 0.8];
// 任意朝向下杯身的外接圆半径（相对 .jiao 宽度）。空中 Z 角与翻滚一直在转，离台边至少留这么远才不会甩出台面
const CUP_REACH = Math.hypot(CUP_HALF[0], CUP_HALF[1]);
const EDGE = 4;             // 落定时离内框线至少留的像素
const GAP = 10;             // 两枚落定之间至少留的像素

/**
 * 画面专用的随机种子。与 randomSide 分开取：只决定落点、转轴、圈数、Z 角与先后，与阴阳无关。
 * @param {Crypto} [cryptoObj]
 * @returns {number} 32 位无符号整数
 */
export function motionSeed(cryptoObj) {
  const c = cryptoObj || globalThis.crypto;
  const buf = new Uint32Array(1);
  c.getRandomValues(buf);
  return buf[0];
}

/**
 * 由种子展开的确定性序列（mulberry32），只供同一次抛掷的画面取样。
 * @param {number} seed
 * @returns {() => number} [0, 1) 均匀
 */
export function motionRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rad = (deg) => deg * Math.PI / 180;
const lerp = (a, b, u) => a + (b - a) * u;
const fit = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
const wrap360 = (deg) => ((deg % 360) + 360) % 360;
const wrap180 = (deg) => wrap360(deg + 180) - 180;
const fix = (n) => Math.round(n * 1000) / 1000;
const easeOut = (u) => 1 - (1 - u) ** 3;
// 翻滚进度：出手最快，越近落地越慢，触地瞬间仍带一点余速
const spinEase = (u) => 0.85 * (1 - (1 - u) ** 2.4) + 0.15 * u;
const yawEase = (u) => 1 - (1 - u) ** 1.8;

/**
 * 筊杯平面法线（朝镜头为 +z）。合成顺序与样式一致：rotate(yaw) · rotateX(rx) · rotateY(ry)。
 * z 为正是阳面（切平面）朝上，为负是阴面（弧壳）朝上；绕 Y 轴翻过来同样会换面，不能只看 rx。
 * @param {{yaw?:number, rx?:number, ry?:number}} pose
 * @returns {[number, number, number]}
 */
export function poseNormal({yaw = 0, rx = 0, ry = 0}) {
  const cz = Math.cos(rad(yaw)), sz = Math.sin(rad(yaw));
  const cx = Math.cos(rad(rx)), sx = Math.sin(rad(rx));
  const cy = Math.cos(rad(ry)), sy = Math.sin(rad(ry));
  // Ry·ẑ = (sy, 0, cy)；再经 Rx 得 (sy, −sx·cy, cx·cy)；Rz 只转平面分量
  const nx = sy, ny = -sx * cy;
  return [cz * nx - sz * ny, sz * nx + cz * ny, cx * cy];
}

/** 姿态朝上的面；正好立在薄边上时为 null。 */
export function faceOfPose(pose) {
  const z = poseNormal(pose)[2];
  if (Math.abs(z) < 1e-9) return null;
  return z > 0 ? 'yang' : 'yin';
}

// 平放筊杯随 Z 角转动后的外接半宽 / 半高
function extents(yaw, jw) {
  const c = Math.abs(Math.cos(rad(yaw))), s = Math.abs(Math.sin(rad(yaw)));
  const hw = CUP_HALF[0] * jw, hh = CUP_HALF[1] * jw;
  return [c * hw + s * hh, s * hw + c * hh];
}

function corners({x, y, yaw}, jw) {
  const c = Math.cos(rad(yaw)), s = Math.sin(rad(yaw));
  const hw = CUP_HALF[0] * jw, hh = CUP_HALF[1] * jw;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
}

// 分离轴：两个转过的矩形之间至少隔 gap 像素
function apart(a, b, gap) {
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % 4];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const nx = (y1 - y2) / len, ny = (x2 - x1) / len;
      const pa = a.map(([x, y]) => x * nx + y * ny);
      const pb = b.map(([x, y]) => x * nx + y * ny);
      if (Math.max(...pa) + gap <= Math.min(...pb) || Math.max(...pb) + gap <= Math.min(...pa)) return true;
    }
  }
  return false;
}

/**
 * 两枚的落点与 Z 角：各自在内框里随机取，左筊仍在右筊左边、两枚互不重叠、不摆成镜像。
 * 成对取样，留下前三组合格的里「挪得最少的那枚也挪得最远」的一组，让每次抛掷在地面上都有看得见的横移。
 */
function sampleLandings(rng, area, from) {
  const {w, h, jw, mat, foot} = area;
  const span = w - 2 * mat;
  const reach = CUP_REACH * jw;
  const spot = (side) => {
    // 至少偏离竖直 12°：窄台面上竖放最容易取到，不压一下就总像又站回了原位
    const yaw = (rng() < 0.5 ? 1 : -1) * (12 + 156 * rng());
    const [ex, ey] = extents(yaw, jw);
    // 左右离台边至少一个外接圆半径：下一次起跳转起来也不会甩出台面；上边略松，最高点可以稍微探出框线
    let lo = Math.max(mat + EDGE + ex, reach), hi = Math.min(w - mat - EDGE - ex, w - reach);
    if (side === 'left') hi = Math.min(hi, mat + span * 0.62);
    else lo = Math.max(lo, mat + span * 0.38);
    const top = Math.max(mat + EDGE + ey, 0.75 * reach), bottom = h - foot - EDGE - ey;
    if (lo > hi || top > bottom) return null;
    return {x: lerp(lo, hi, rng()), y: lerp(top, bottom, rng()), yaw};
  };
  const moved = (s, side) => Math.hypot(s.x - from[side].u * w, s.y - from[side].v * h);
  let best = null;
  for (let tries = 0, found = 0; tries < 80 && found < 3; tries++) {
    const left = spot('left'), right = spot('right');
    if (!left || !right || right.x - left.x < 0.1 * w) continue;
    if (!apart(corners(left, jw), corners(right, jw), GAP)) continue;
    const mirror = Math.abs(left.y - right.y) < 0.02 * h && Math.abs(left.x - (w - right.x)) < 0.02 * w
      && Math.abs(left.yaw + right.yaw) < 4;
    if (mirror) continue;
    found += 1;
    const score = Math.min(moved(left, 'left'), moved(right, 'right'));
    if (!best || score > best.score) best = {left, right, score};
  }
  if (best) return best;
  // 台面窄到取不出时的保底：左筊竖斜在左上，右筊斜躺在右下
  const room = h - foot - mat;
  return {
    left: {x: mat + span * 0.27, y: mat + room * 0.45, yaw: -12},
    right: {x: mat + span * 0.73, y: mat + room * 0.6, yaw: 28},
  };
}

/**
 * 翻滚：轴在筊杯平面内，与 X 轴夹角 axis（度）。X 翻跟头、Y 侧滚、斜轴两轴一起转三种各占三分之一；
 * 5–8 个半圈（2.5–4 圈），奇偶由起止两面决定。与左筊同轴型、同圈、同向时，右筊反过来转。
 */
function sampleTumble(rng, from, face, avoid) {
  const odd = (deg) => ((Math.round(deg / 180) % 2) + 2) % 2;
  const need = ((face === 'yin' ? 1 : 0) + odd(from.rx) + odd(from.ry)) % 2;
  const mode = ['x', 'y', 'xy'][Math.floor(rng() * 3)];
  const axis = mode === 'x' ? -12 + 24 * rng()
    : mode === 'y' ? 78 + 24 * rng()
      : (rng() < 0.5 ? 25 : 115) + 40 * rng();
  const n = 5 + Math.floor(rng() * 4);
  const turns = n % 2 === need ? n : n + (n < 8 ? 1 : -1);
  let dir = rng() < 0.5 ? 1 : -1;
  if (avoid && avoid.tumble.mode === mode && avoid.tumble.turns === turns && avoid.tumble.dir === dir) dir = -dir;
  return {mode, axis, turns, dir, residual: 16 + 14 * rng()};
}

function planCup(side, face, from, spot, area, rng, {startAt, contactAt, avoid}) {
  const {w, h, jw} = area;
  const tumble = sampleTumble(rng, from, face, avoid);
  const {axis, turns, dir, residual} = tumble;
  // 绕平面内的轴翻奇数个半圈 = 先绕 X（或 Y）翻一次，再在平面里转 2·axis（或 2·axis + 180°）。
  // 静止姿态按轴更贴近哪一边记成 rx 或 ry 翻转，画面上是同一个矩阵。
  const flipped = turns % 2 === 1;
  const aboutY = Math.abs(Math.sin(rad(axis))) > Math.abs(Math.cos(rad(axis)));
  const fold = flipped ? 2 * axis + (aboutY ? 180 : 0) : 0;
  const rest = {
    rx: flipped && !aboutY ? wrap360(from.rx + 180) : from.rx,
    ry: flipped && aboutY ? wrap360(from.ry + 180) : from.ry,
  };
  // Z 角：至少转 100°，方向随机；触地后再滑转一小段。落定后的朝向就是取样的落点角
  const spinZ = rng() < 0.5 ? 1 : -1;
  let dYaw = wrap180(spot.yaw - fold - from.yaw);
  if (dYaw * spinZ < 0) dYaw += 360 * spinZ;
  if (Math.abs(dYaw) < 100) dYaw += 360 * spinZ;
  const yawEnd = from.yaw + dYaw;
  const yawContact = yawEnd - Math.sign(dYaw) * Math.min(22, Math.abs(dYaw) * 0.12);
  // 地面轨迹：起点 → 触地点走一段弯弧，触地后顺势滑到落点
  const p0 = [from.u * w, from.v * h];
  const p1 = [spot.x, spot.y];
  const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const turn = rng() * 2 * Math.PI;
  const heading = dist >= 1 ? [(p1[0] - p0[0]) / dist, (p1[1] - p0[1]) / dist] : [Math.cos(turn), Math.sin(turn)];
  const slide = Math.min(0.06 * jw + 0.1 * dist, 0.3 * jw, 0.6 * dist);
  const pc = [p1[0] - heading[0] * slide, p1[1] - heading[1] * slide];
  const lift = 1.26 + 0.1 * rng();
  // 最高点在弧线中段：偏离直线一点，并向外甩开（左筊往左、右筊往右），两枚在空中不撞成一团；
  // 放大后的杯身中心仍留在台面里
  const mid = [(p0[0] + pc[0]) / 2, (p0[1] + pc[1]) / 2];
  const bow = (rng() * 2 - 1) * 0.2 * Math.hypot(pc[0] - p0[0], pc[1] - p0[1]);
  const out = (side === 'left' ? -1 : 1) * (0.2 + 0.15 * rng()) * jw;
  const reach = CUP_REACH * jw * lift;
  const apex = [
    fit(mid[0] - heading[1] * bow + out, reach, w - reach),
    fit(mid[1] + heading[0] * bow, 0.8 * reach, h - 0.8 * reach),
  ];
  const ctrl = [2 * apex[0] - mid[0], 2 * apex[1] - mid[1]];
  const to = {u: p1[0] / w, v: p1[1] / h, yaw: wrap180(yawEnd + fold), rx: rest.rx, ry: rest.ry};
  if (faceOfPose(to) !== face) throw new Error('motion plan must land on the drawn side');
  const end = dir * 180 * turns;
  return {
    side, face, from, to,
    startAt, contactAt, settleAt: contactAt + ROCK_MS,
    tumble, lift,
    hops: [0.18 + 0.08 * rng(), 0.05],
    path: {p0, ctrl, pc, p1},
    yaw: [from.yaw, yawContact, yawEnd],
    // 翻滚角：起点、触地时还差一点没转平、停稳
    roll: [0, end - dir * residual, end],
  };
}

/**
 * 排一次抛掷的画面。faces 是已经定好的两枚阴阳，from 是两枚当前真实的静止姿态，
 * area 是台面几何（像素：w/h 台面，jw 筊杯宽，mat 内框缩进，foot 底部图例高度），
 * rng 只来自 motionRng(motionSeed())。不改动阴阳；落定姿态的法线严格对应传入的阴阳。
 * @returns {{durationMs:number, area:object, left:object, right:object}}
 */
export function planCast({faces, from, area, rng}) {
  if (!SIDES.includes(faces.left) || !SIDES.includes(faces.right)) {
    throw new RangeError('side must be "yang" or "yin"');
  }
  // 空中两枚杯心至少隔 1.1 个杯宽，否则整组重排；窄台面上偶尔排不开，就留隔得最远的那组
  let best = null;
  for (let tries = 0; tries < 12 && !(best && best.gap >= 1.1 * area.jw); tries++) {
    const spots = sampleLandings(rng, area, from);
    // 左筊先出手先触地；右筊晚 120–190ms 触地，空中时间各自抖一点
    const leftContact = Math.round(960 + 60 * rng());
    const rightAir = Math.round(1000 + 60 * rng());
    const rightContact = Math.round(leftContact + 120 + 70 * rng());
    const left = planCup('left', faces.left, from.left, spots.left, area, rng, {startAt: 0, contactAt: leftContact});
    const right = planCup('right', faces.right, from.right, spots.right, area, rng,
      {startAt: rightContact - rightAir, contactAt: rightContact, avoid: left});
    const gap = airGap(left, right);
    if (!best || gap > best.gap) best = {left, right, gap};
  }
  return {durationMs: ROLL_DURATION_MS, area, left: best.left, right: best.right};
}

// 任一枚离地时两枚杯心的最近距离（像素）；都躺在台面上时由落点取样保证不重叠
function airGap(a, b) {
  let gap = Infinity;
  for (let t = 0; t <= b.settleAt; t += 20) {
    const p = poseAt(a, t), q = poseAt(b, t);
    if (p.z > 0.02 || q.z > 0.02) gap = Math.min(gap, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return gap;
}

function hop([h1, h2], tau) {
  if (tau < HOPS_MS[0]) {
    const w = tau / HOPS_MS[0];
    return h1 * 4 * w * (1 - w);
  }
  const w = (tau - HOPS_MS[0]) / HOPS_MS[1];
  return w < 1 ? h2 * 4 * w * (1 - w) : 0;
}

/**
 * 一枚筊杯在 t 毫秒（从点击算起）的姿态：x/y 是台面上的像素位置，z 是离地高度（最高点为 1），
 * scale 是向镜头的放大；画面是 rotate(yaw) · rotate3d(axis, tumble) · rotateX(rx) · rotateY(ry)。
 * 动画期间角度不折回，停稳后与 plan.to 是同一个矩阵。
 */
export function poseAt(cup, t) {
  const {path, yaw, roll, lift} = cup;
  const base = {axis: cup.tumble.axis, rx: cup.from.rx, ry: cup.from.ry};
  if (t <= cup.startAt) return {x: path.p0[0], y: path.p0[1], z: 0, scale: 1, yaw: yaw[0], tumble: roll[0], ...base};
  if (t >= cup.settleAt) return {x: path.p1[0], y: path.p1[1], z: 0, scale: 1, yaw: yaw[2], tumble: roll[2], ...base};
  if (t < cup.contactAt) {
    const u = (t - cup.startAt) / (cup.contactAt - cup.startAt);
    const a = 1 - u;
    const z = 4 * u * a;
    return {
      x: a * a * path.p0[0] + 2 * a * u * path.ctrl[0] + u * u * path.pc[0],
      y: a * a * path.p0[1] + 2 * a * u * path.ctrl[1] + u * u * path.pc[1],
      z,
      scale: 1 + (lift - 1) * z,
      yaw: lerp(yaw[0], yaw[1], yawEase(u)),
      tumble: lerp(roll[0], roll[1], spinEase(u)),
      ...base,
    };
  }
  // 触地：拍平时冲过头再晃回来，同时两次短促回弹、顺势滑一小段，全部衰减到停稳
  const tau = t - cup.contactAt;
  const glide = easeOut(Math.min(1, tau / SLIDE_MS));
  const z = hop(cup.hops, tau);
  const sway = -cup.tumble.residual * Math.exp(-tau / 120) * Math.cos(Math.PI * tau / 120) * (1 - tau / ROCK_MS);
  return {
    x: lerp(path.pc[0], path.p1[0], glide),
    y: lerp(path.pc[1], path.p1[1], glide),
    z,
    scale: 1 + (lift - 1) * z,
    yaw: lerp(yaw[1], yaw[2], glide),
    tumble: roll[2] + cup.tumble.dir * sway,
    ...base,
  };
}

/**
 * 把一枚筊杯的规划采样成 WAAPI 关键帧，四层各播一段、同起同止：
 * .toss 平移（地面位置，相对落点）并按高度定前后；.jiao 转 Z 角并按高度放大；.spin 翻滚；
 * 影子贴地，跟着 Z 角与翻滚投影；光从镜头前上方来，越高越往下偏、越大、越淡、越虚。末帧与静止样式一致。
 */
export function castKeyframes(cup, area, durationMs) {
  const times = new Set([durationMs, cup.startAt, cup.contactAt, cup.settleAt,
    cup.contactAt + HOPS_MS[0] / 2, cup.contactAt + HOPS_MS[0], cup.contactAt + HOPS_MS[0] + HOPS_MS[1] / 2]);
  for (let t = 0; t < durationMs; t += FRAME_STEP_MS) times.add(t);
  const end = poseAt(cup, durationMs);
  const jw = area.jw;
  // 同一根轴写成同样的字符串：rotate3d 轴相同，浏览器才按角度数值插值，多圈不会被折成最短路径
  const axis = [Math.cos(rad(cup.tumble.axis)), Math.sin(rad(cup.tumble.axis))].map((n) => n.toFixed(6)).join(', ');
  const out = {toss: [], jiao: [], spin: [], shadow: []};
  for (const t of [...times].filter((t) => t >= 0 && t <= durationMs).sort((a, b) => a - b)) {
    const p = poseAt(cup, t);
    const offset = t / durationMs;
    const tumble = `rotate3d(${axis}, 0, ${fix(p.tumble)}deg) rotateX(${p.rx}deg) rotateY(${p.ry}deg)`;
    // 离地越高越靠前：两枚在空中交错时，高的那枚盖住低的
    out.toss.push({offset, translate: `${fix(p.x - end.x)}px ${fix(p.y - end.y)}px`, zIndex: String(2 + Math.round(p.z * 8))});
    out.jiao.push({offset, rotate: `${fix(p.yaw)}deg`, scale: String(fix(p.scale))});
    out.spin.push({offset, transform: tumble});
    out.shadow.push({
      offset,
      transform: tumble,
      rotate: `${fix(p.yaw)}deg`,
      translate: `${fix(jw * (0.02 + 0.08 * p.z))}px ${fix(jw * (0.045 + 0.3 * p.z))}px`,
      scale: String(fix(1 + 0.3 * p.z)),
      opacity: String(fix(0.34 * (1 - 0.7 * p.z))),
      filter: `blur(${fix(jw * (0.012 + 0.07 * p.z))}px)`,
    });
  }
  return out;
}

/**
 * 由规划排出阶段：出手、翻滚、左筊触地、右筊触地。每枚在自己停稳那一刻才标为 landed（亮出朝向），
 * 结果只在最后一帧、双杯都停稳之后揭晓。
 * @returns {{durationMs:number, frames:Array<{at:number,phase:string,left:string,right:string,reveal:boolean}>}}
 */
export function buildRollTimeline(plan) {
  const {left, right, durationMs} = plan;
  const state = (cup, t) => (t < TUMBLE_AT ? 'launch' : t < cup.contactAt ? 'tumble' : t < cup.settleAt ? 'landing' : 'landed');
  const phase = (t) => (t < TUMBLE_AT ? 'launch' : t < left.contactAt ? 'tumble' : t < right.contactAt ? 'land-left' : 'land-right');
  const times = [...new Set([0, TUMBLE_AT, left.contactAt, right.contactAt, left.settleAt, right.settleAt, durationMs])]
    .sort((a, b) => a - b);
  return {
    durationMs,
    frames: times.map((at) => ({
      at, phase: phase(at), left: state(left, at), right: state(right, at), reveal: at === durationMs,
    })),
  };
}

// ---------- DOM ----------

function prefersReducedMotion() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 静止姿态：初值写在样式表里，之后每次落定写回筊杯的行内变量，下一次就从这里起投。
function readPose(cup) {
  const cs = getComputedStyle(cup);
  const num = (name) => parseFloat(cs.getPropertyValue(name)) || 0;
  return {u: num('--u'), v: num('--v'), yaw: num('--yaw'), rx: num('--rx'), ry: num('--ry')};
}

function writePose(cup, pose) {
  cup.style.setProperty('--u', String(pose.u));
  cup.style.setProperty('--v', String(pose.v));
  cup.style.setProperty('--yaw', `${pose.yaw}deg`);
  cup.style.setProperty('--rx', `${pose.rx}deg`);
  cup.style.setProperty('--ry', `${pose.ry}deg`);
}

// 减弱动效：原地换面，不挪位置、不改 Z 角。
function layFlat(pose, side) {
  return faceOfPose(pose) === side ? pose : {...pose, rx: wrap360(pose.rx + 180)};
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
  const cups = {
    left: doc.querySelector('[data-cup="left"]'),
    right: doc.querySelector('[data-cup="right"]'),
  };
  if (!stage || !readout || !title || !blocks.left || !blocks.right || !cups.left || !cups.right) return;

  const poses = {left: readPose(cups.left), right: readPose(cups.right)};
  const running = [];
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

  // 台面几何：内框缩进与底部图例高度来自样式表变量，筊杯宽取 .toss 的布局宽度（不受变换影响）。
  function measureArea() {
    const cs = getComputedStyle(stage);
    return {
      w: stage.clientWidth,
      h: stage.clientHeight,
      jw: cups.left.offsetWidth,
      mat: parseFloat(cs.getPropertyValue('--mat')) || 0,
      foot: parseFloat(cs.getPropertyValue('--mat-foot')) || 0,
    };
  }

  // 一次抛掷，每枚四层动画同起同止、只播一遍；落脚点先挪到终点，.toss 的平移从「起点 − 终点」走回 0。
  function play(plan) {
    for (const side of ['left', 'right']) {
      const cup = cups[side];
      const frames = castKeyframes(plan[side], plan.area, plan.durationMs);
      const timing = {duration: plan.durationMs, fill: 'forwards'};
      cup.style.setProperty('--u', String(plan[side].to.u));
      cup.style.setProperty('--v', String(plan[side].to.v));
      running.push(
        cup.animate(frames.toss, timing),
        cup.querySelector('.jiao').animate(frames.jiao, timing),
        cup.querySelector('.spin').animate(frames.spin, timing),
        cup.querySelector('.jiao-shadow').animate(frames.shadow, timing),
      );
    }
  }

  // 阶段只驱动文案与每枚的状态；轨迹已经整段交给 WAAPI，中途不重启。
  function applyFrame(f, plan) {
    stage.dataset.rollPhase = f.phase;
    for (const side of ['left', 'right']) {
      if (blocks[side].dataset.rollState === f[side]) continue;
      setBlockState(blocks[side], f[side]);
      // 这一枚停稳了才亮出它的朝向；整体结果仍等双杯都停稳之后再揭晓。
      if (f[side] === 'landed') setBlock(blocks[side], plan[side].face);
    }
  }

  function roll() {
    if (rolling) return;

    // 先定结果：每枚筊杯各取一次 Web Crypto，之后谁也不再改它。
    const left = randomSide();
    const right = randomSide();
    // 再排画面：落点、转轴、圈数、Z 角另取一个种子展开，与结果无关。所有可能失败的计算都在上锁之前。
    const animated = !prefersReducedMotion() && typeof stage.animate === 'function';
    const plan = animated
      ? planCast({faces: {left, right}, from: poses, area: measureArea(), rng: motionRng(motionSeed())})
      : null;
    const timeline = plan && buildRollTimeline(plan);

    rolling = true;
    triggers.forEach((b) => { b.disabled = true; });
    stage.classList.add('is-rolling');
    doc.body.classList.add('is-rolling');

    const settle = () => {
      count += 1;
      poses.left = plan ? plan.left.to : layFlat(poses.left, left);
      poses.right = plan ? plan.right.to : layFlat(poses.right, right);
      // 静止样式写成动画末帧的同一个姿态，再取消动画：落在哪、歪成什么角度就留在那里。
      writePose(cups.left, poses.left);
      writePose(cups.right, poses.right);
      running.splice(0).forEach((a) => a.cancel());
      render(left, right);
      delete stage.dataset.rollPhase;
      setBlockState(blocks.left, null);
      setBlockState(blocks.right, null);
      stage.classList.remove('is-rolling');
      doc.body.classList.remove('is-rolling');
      triggers.forEach((b) => { b.disabled = false; });
      rolling = false;
    };

    if (!plan) {
      settle();
      return;
    }

    renderRolling();
    play(plan);
    timeline.frames.forEach((f) => {
      setTimeout(() => {
        applyFrame(f, plan);
        if (f.reveal) settle();
      }, f.at);
    });
  }

  triggers.forEach((b) => b.addEventListener('click', roll));
  // 点台面上的筊杯本身也掷：筊杯画在按钮外面，飞出半区时不会被按钮裁掉。
  cups.left.addEventListener('click', roll);
  cups.right.addEventListener('click', roll);
}

// 仅在浏览器中挂载；Node 里 import 本文件只拿 classify 等纯函数。
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(document), { once: true });
  } else {
    init(document);
  }
}
