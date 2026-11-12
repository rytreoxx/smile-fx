// 粒子系统：结构数组（SoA）+ 定长 TypedArray 池 + swap-remove。
//
// 性能红线相关的设计：
//  - 零 GC：所有粒子状态预分配在 Float32Array 中，运行期不 new 对象，不会因 GC 产生卡顿尖刺；
//  - O(1) 删除：死亡粒子用末尾元素覆盖（swap-remove），无数组 splice；
//  - 批量绘制：雨滴按一条 Path 一次 stroke；烟花按颜色分桶，用预渲染的发光贴图 drawImage，
//    不在每个粒子上切换 fillStyle / shadowBlur（shadowBlur 是 Canvas2D 最贵的操作之一，完全不用）；
//  - 容量上限 cap 由自适应画质控制器动态调整，低端机自动降级。

export const RAIN = 0, SPLASH = 1, ROCKET = 2, SPARK = 3;
const MAX = 5000;

export const PALETTE = [
  [255, 211, 107], [255, 122, 89], [255, 92, 160], [142, 197, 255],
  [140, 255, 196], [200, 150, 255], [255, 255, 255], [255, 170, 60],
];
const ALPHA_LEVELS = 4;

export class Particles {
  constructor() {
    this.x = new Float32Array(MAX); this.y = new Float32Array(MAX);
    this.vx = new Float32Array(MAX); this.vy = new Float32Array(MAX);
    this.life = new Float32Array(MAX); this.ttl = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.type = new Uint8Array(MAX); this.col = new Uint8Array(MAX);
    this.n = 0; this.cap = 3500;
    this.unit = 1;            // 屏幕尺度系数：保证手机与桌面上视觉比例一致
    this.hits = 0;            // 统计：本秒碰撞次数（HUD 展示）
    this.sprites = null;      // Canvas2D 回退路径才需要，懒加载
    this._colorCount = new Uint16Array(PALETTE.length);
  }

  setViewport(w, h) { this.W = w; this.H = h; this.unit = Math.min(w, h) / 800; }
  clear() { this.n = 0; }

  spawn(t, x, y, vx, vy, ttl, size, col) {
    if (this.n >= this.cap) return -1;     // 满载直接丢弃新粒子，而不是挤掉旧粒子或扩容
    const i = this.n++;
    this.type[i] = t; this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = ttl; this.ttl[i] = ttl; this.size[i] = size; this.col[i] = col;
    return i;
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    this.type[i] = this.type[j]; this.x[i] = this.x[j]; this.y[i] = this.y[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.life[i] = this.life[j];
    this.ttl[i] = this.ttl[j]; this.size[i] = this.size[j]; this.col[i] = this.col[j];
  }

  // ---------- 发射器 ----------
  emitRain(count, intensity) {
    const u = this.unit, W = this.W;
    const wind = -40 * u;
    for (let k = 0; k < count; k++) {
      const vy = (950 + Math.random() * 450) * u * (0.85 + intensity * 0.35);
      this.spawn(RAIN, Math.random() * (W + 80) - 20, -20 - Math.random() * 60, wind, vy, 3, 1 + Math.random() * 0.8, 3);
    }
  }

  launchRocket(intensity) {
    const u = this.unit, W = this.W, H = this.H;
    const g = 520 * u;
    const apex = H * (0.1 + Math.random() * 0.3);
    const vy = -Math.sqrt(2 * g * (H - apex));
    const x = W * (0.12 + Math.random() * 0.76);
    const vx = (W * 0.5 - x) * 0.15 + (Math.random() - 0.5) * 60 * u;
    const col = (Math.random() * PALETTE.length) | 0;
    this.spawn(ROCKET, x, H + 10, vx, vy, 4, 1 + intensity * 0.6, col);
  }

  explode(x, y, col, power) {
    const u = this.unit;
    const count = (60 + power * 90) | 0;
    const col2 = (col + 1 + ((Math.random() * 3) | 0)) % PALETTE.length;
    const speed = (240 + power * 220) * u;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + Math.random() * 0.2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.spawn(SPARK, x, y, Math.cos(a) * s, Math.sin(a) * s, 1.1 + Math.random() * 0.9, 0.8 + Math.random() * 0.6, Math.random() < 0.7 ? col : col2);
    }
  }

  // ---------- 物理 ----------
  // head: HeadCollider；dt 秒
  update(dt, head) {
    const u = this.unit, W = this.W, H = this.H;
    const useHead = head.usable;
    const hx = head.ex, hy = head.ey, hrx = head.rx, hry = head.ry, hvx = head.vx, hvy = head.vy;
    const c = Math.cos(head.rot), s = Math.sin(head.rot);
    const irx2 = 1 / (hrx * hrx || 1), iry2 = 1 / (hry * hry || 1);
    // 碰撞粗筛：先用外接圆判断，绝大多数粒子在这里就被排除，省掉旋转变换
    const bound = Math.max(hrx, hry) + 4, bound2 = bound * bound;
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy, L = this.life, T = this.type;
    const gSpark = 420 * u, gSplash = 1600 * u, gRocket = 520 * u;
    const dragSpark = Math.exp(-1.4 * dt);

    for (let i = this.n - 1; i >= 0; i--) {
      const t = T[i];
      L[i] -= dt;
      if (t === SPARK) { VX[i] *= dragSpark; VY[i] = VY[i] * dragSpark + gSpark * dt; }
      else if (t === SPLASH) { VY[i] += gSplash * dt; }
      else if (t === ROCKET) { VY[i] += gRocket * dt; }

      X[i] += VX[i] * dt; Y[i] += VY[i] * dt;

      // —— 头部碰撞（椭圆，旋转局部空间）——
      if (useHead) {
        const dx = X[i] - hx, dy = Y[i] - hy;
        if (dx * dx + dy * dy < bound2) {
          const lx = c * dx + s * dy, ly = -s * dx + c * dy;
          const q = lx * lx * irx2 + ly * ly * iry2;
          if (q < 1) {
            // 推回椭圆表面
            const k = q > 1e-6 ? 1 / Math.sqrt(q) : 1;
            const px = lx * k, py = q > 1e-6 ? ly * k : -hry;
            let nlx = px * irx2, nly = py * iry2; const nl = Math.hypot(nlx, nly) || 1; nlx /= nl; nly /= nl;
            const nx = c * nlx - s * nly, ny = s * nlx + c * nly;
            X[i] = hx + c * px - s * py + nx * 1.5; Y[i] = hy + s * px + c * py + ny * 1.5;

            if (t === RAIN) {
              // 雨滴砸到头上：碎成 2 颗水花沿法线 + 切线方向溅开
              const sp = 160 * u;
              this.spawn(SPLASH, X[i], Y[i], nx * sp + ny * sp * 0.8 + hvx * 0.5, ny * sp - nx * sp * 0.8 - 80 * u, 0.45, 1, 3);
              this.spawn(SPLASH, X[i], Y[i], nx * sp - ny * sp * 0.8 + hvx * 0.5, ny * sp + nx * sp * 0.8 - 80 * u, 0.45, 1, 3);
              this.hits++; this.kill(i); continue;
            }
            if (t === ROCKET) { // 火箭撞到头直接在头顶炸开
              this.explode(X[i], Y[i], this.col[i], 0.6); this.hits++; this.kill(i); continue;
            }
            // 火花 / 水花：基于相对速度的反射（带头部动量传递）+ 切向摩擦
            const e = t === SPARK ? 0.55 : 0.3, f = 0.12;
            let rvx = VX[i] - hvx, rvy = VY[i] - hvy;
            const vn = rvx * nx + rvy * ny;
            if (vn < 0) {
              rvx -= (1 + e) * vn * nx; rvy -= (1 + e) * vn * ny;
              const vt = rvx * -ny + rvy * nx;   // 切向分量
              rvx -= f * vt * -ny; rvy -= f * vt * nx;
              this.hits++;
            }
            VX[i] = rvx + hvx; VY[i] = rvy + hvy;
          }
        }
      }

      // —— 生命周期 ——
      if (t === RAIN) { if (Y[i] > H + 30) { this.kill(i); continue; } }
      else if (t === ROCKET) {
        if (VY[i] >= -40 * u || L[i] <= 0) { this.explode(X[i], Y[i], this.col[i], this.size[i] - 0.6 + 0.4); this.kill(i); continue; }
      } else if (L[i] <= 0 || Y[i] > H + 40 || X[i] < -60 || X[i] > W + 60) { this.kill(i); continue; }
    }
  }

  // ---------- 渲染（Canvas2D 回退路径；默认走 renderer-gl.js） ----------
  render(ctx) {
    const n = this.n; if (n === 0) return;
    if (!this.sprites) this.sprites = buildSprites();
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy, T = this.type, u = this.unit;

    // 1) 雨滴 + 水花：一条 Path，一次 stroke
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(190,220,255,0.55)';
    ctx.lineWidth = 1.4 * Math.max(1, u);
    ctx.lineCap = 'round';
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < n; i++) {
      const t = T[i];
      if (t === RAIN) { ctx.moveTo(X[i], Y[i]); ctx.lineTo(X[i] - VX[i] * 0.018, Y[i] - VY[i] * 0.018); any = true; }
      else if (t === SPLASH) { ctx.moveTo(X[i], Y[i]); ctx.lineTo(X[i] - VX[i] * 0.03, Y[i] - VY[i] * 0.03); any = true; }
    }
    if (any) ctx.stroke();

    // 2) 火花 / 火箭：加色混合 + 预渲染发光贴图（按 颜色 × 透明度档 查表，无状态切换）
    ctx.globalCompositeOperation = 'lighter';
    const L = this.life, TT = this.ttl, S = this.size, C = this.col, spr = this.sprites;
    const base = 14 * Math.max(0.7, u);
    for (let i = 0; i < n; i++) {
      const t = T[i];
      if (t === SPARK) {
        const r = L[i] / TT[i];
        const lvl = r > 0.75 ? 3 : r > 0.5 ? 2 : r > 0.25 ? 1 : 0;
        const sz = base * S[i] * (0.5 + r * 0.5);
        ctx.drawImage(spr[C[i] * ALPHA_LEVELS + lvl], X[i] - sz / 2, Y[i] - sz / 2, sz, sz);
      } else if (t === ROCKET) {
        const sz = base * 1.6;
        ctx.drawImage(spr[C[i] * ALPHA_LEVELS + 3], X[i] - sz / 2, Y[i] - sz / 2, sz, sz);
        // 尾焰：沿速度反方向画 3 个渐小光点（3 次 drawImage，比 per-frame 渐变便宜得多）
        for (let k = 1; k <= 3; k++) {
          const q = sz * (1 - k * 0.22);
          ctx.drawImage(spr[C[i] * ALPHA_LEVELS + (3 - k)], X[i] - VX[i] * 0.012 * k - q / 2, Y[i] - VY[i] * 0.012 * k - q / 2, q, q);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

// 预渲染发光贴图：8 色 × 4 透明度档 = 32 张 32px 小图，启动时一次性生成
function buildSprites() {
  const out = [];
  for (const [r, g, b] of PALETTE) {
    for (let lv = 0; lv < ALPHA_LEVELS; lv++) {
      const a = (lv + 1) / ALPHA_LEVELS;
      const cv = document.createElement('canvas'); cv.width = cv.height = 32;
      const x = cv.getContext('2d');
      const grd = x.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(0.25, `rgba(${r},${g},${b},${a * 0.9})`);
      grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
      x.fillStyle = grd; x.fillRect(0, 0, 32, 32);
      out.push(cv);
    }
  }
  return out;
}
