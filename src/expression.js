// 表情状态机：把逐帧带噪声的 blendshape 分数变成稳定的 NEUTRAL / SMILE / LAUGH 三态。
//
// 设计要点（都是为了“精准触发”与不误触）：
// 1. 个人基线校准：有人静息脸本身就带笑（smile≈0.2），直接用绝对阈值会常驻“下雨”。
//    进入后采集 ~1s 中性表情的均值作为基线，后续使用 (raw - baseline) 归一化。
// 2. EMA 平滑：抑制 landmark 抖动。
// 3. 双阈值迟滞 + 最短保持时间：进入阈值 > 退出阈值，状态需持续 N ms 才切换，避免在临界值附近闪烁。
// 4. 语义约束：大笑必须“笑 + 张嘴”同时成立。单纯张嘴（说话 / 惊讶 / 打哈欠）不会放烟花，
//    这是直播场景里最常见的误触来源（主播一直在说话）。

export const STATE = { NONE: 'none', NEUTRAL: 'neutral', SMILE: 'smile', LAUGH: 'laugh' };

const CAL_MS = 1000;           // 校准时长
const EMA_A = 0.4;             // 平滑系数（越大越跟手）

// 阈值都作用在“校准后”的信号上，sens 为灵敏度倍率（UI 可调）
const T = {
  smileEnter: 0.42, smileExit: 0.26,
  jawEnter: 0.30,   jawExit: 0.17,
  holdEnter: 140,   // ms，进入需持续
  holdExit: 260,    // ms，退出需持续（退出慢一些，体验更“粘手”，不会一眨眼就停雨）
};

export class ExpressionFSM {
  constructor() { this.sens = 1; this.reset(); }

  reset() {
    this.state = STATE.NEUTRAL;
    this.smile = 0; this.jaw = 0;           // 校准后的平滑值 0..1
    this.rawSmile = 0; this.rawJaw = 0;
    this.base = { smile: 0, jaw: 0 };
    this.cal = { start: -1, n: 0, s: 0, j: 0, done: false };
    this.pending = null; this.pendingSince = 0;
  }

  get calibrating() { return !this.cal.done; }
  get thresholds() { return { smile: T.smileEnter / this.sens, jaw: T.jawEnter / this.sens }; }

  // blend: Map<name, score>；now: performance.now()
  update(blend, now) {
    const sm = ((blend.get('mouthSmileLeft') ?? 0) + (blend.get('mouthSmileRight') ?? 0)) / 2;
    const jw = blend.get('jawOpen') ?? 0;
    this.rawSmile = sm; this.rawJaw = jw;

    if (!this.cal.done) {
      if (this.cal.start < 0) this.cal.start = now;
      this.cal.n++; this.cal.s += sm; this.cal.j += jw;
      if (now - this.cal.start >= CAL_MS && this.cal.n >= 8) {
        // 基线上限：如果校准时用户已经在大笑，基线会被抬高到无法触发，这里做截断兜底
        this.base.smile = Math.min(this.cal.s / this.cal.n, 0.35);
        this.base.jaw = Math.min(this.cal.j / this.cal.n, 0.2);
        this.cal.done = true;
      }
      return this.state;
    }

    const ns = clamp01((sm - this.base.smile) / (1 - this.base.smile));
    const nj = clamp01((jw - this.base.jaw) / (1 - this.base.jaw));
    this.smile += (ns - this.smile) * EMA_A;
    this.jaw += (nj - this.jaw) * EMA_A;

    const k = this.sens;
    const sE = T.smileEnter / k, sX = T.smileExit / k, jE = T.jawEnter / k, jX = T.jawExit / k;
    const s = this.smile, j = this.jaw;

    // 计算“目标状态”，当前状态决定使用进入阈值还是退出阈值（迟滞）
    let target = this.state;
    switch (this.state) {
      case STATE.NEUTRAL:
        if (s > sE && j > jE) target = STATE.LAUGH;
        else if (s > sE) target = STATE.SMILE;
        break;
      case STATE.SMILE:
        if (s < sX) target = STATE.NEUTRAL;
        else if (j > jE) target = STATE.LAUGH;
        break;
      case STATE.LAUGH:
        // 大笑时嘴角常被张嘴“拉平”，smile 分数会下降，所以退出大笑用更宽松的 smile 下限
        if (s < sX * 0.75) target = STATE.NEUTRAL;
        else if (j < jX) target = STATE.SMILE;
        break;
    }

    if (target === this.state) { this.pending = null; return this.state; }
    if (this.pending !== target) { this.pending = target; this.pendingSince = now; return this.state; }
    const entering = rank(target) > rank(this.state);
    if (now - this.pendingSince >= (entering ? T.holdEnter : T.holdExit)) {
      this.state = target; this.pending = null;
    }
    return this.state;
  }

  // 0..1 的特效强度：用于雨量 / 烟花密度，做到“笑得越开效果越强”
  intensity() {
    const k = this.sens;
    if (this.state === STATE.SMILE) return clamp01((this.smile - T.smileExit / k) / (1 - T.smileExit / k));
    if (this.state === STATE.LAUGH) return clamp01((this.jaw - T.jawExit / k) / (0.8 - T.jawExit / k));
    return 0;
  }
}

const rank = (s) => (s === STATE.LAUGH ? 2 : s === STATE.SMILE ? 1 : 0);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
