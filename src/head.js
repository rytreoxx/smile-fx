// 头部碰撞体：用 Face Landmarker 的 4 个关键点拟合一个“带旋转的椭圆”（含头发外扩）。
//
// 为什么不用 468 点网格做精确碰撞？
//  - 粒子 × 网格三角面是 O(N·M)：3000 粒子 × ~900 三角面 / 帧，手机必然掉帧；
//  - 粒子是氛围特效，用户感知的是“砸到头上弹开”，椭圆在视觉上已足够可信。
//  刻意的 ROI 取舍：碰撞成本降到 O(N)，每个粒子只有十几次乘加，且零内存分配。
//
// 推理 30Hz、渲染 60Hz+：两次推理之间用速度外推碰撞体位置，避免碰撞体一顿一顿。

const L_CHEEK = 234, R_CHEEK = 454, FOREHEAD = 10, CHIN = 152;
const P = new Float32Array(8); // 复用的坐标缓冲，避免每帧分配数组

export class HeadCollider {
  constructor() {
    this.active = false;   // 当前是否有有效人脸
    this.alpha = 0;        // 0..1 渐入渐出：人脸丢失时碰撞体淡出，不会让粒子撞上“幽灵头”
    this.cx = 0; this.cy = 0; this.ex = 0; this.ey = 0; // 测量中心 / 外推中心
    this.rx = 0; this.ry = 0; this.rot = 0;
    this.vx = 0; this.vy = 0;          // 头部速度 px/s：晃头可以把粒子“顶飞”
    this.t = 0; this._init = false;
  }

  // lm: 归一化 landmarks；map(nx, ny, out, offset): 视频→屏幕映射（含镜像与 object-fit: cover 裁切）
  measure(lm, map, now) {
    map(lm[L_CHEEK].x, lm[L_CHEEK].y, P, 0);
    map(lm[R_CHEEK].x, lm[R_CHEEK].y, P, 2);
    map(lm[FOREHEAD].x, lm[FOREHEAD].y, P, 4);
    map(lm[CHIN].x, lm[CHIN].y, P, 6);
    const lx = P[0], ly = P[1], rx = P[2], ry = P[3], fx = P[4], fy = P[5], chx = P[6], chy = P[7];

    // 头部倾斜（roll）：两颊连线角度，归一化到 (-90°, 90°]，兼容镜像后左右互换
    let rot = Math.atan2(ry - ly, rx - lx);
    if (rot > Math.PI / 2) rot -= Math.PI; else if (rot <= -Math.PI / 2) rot += Math.PI;

    const faceW = Math.hypot(rx - lx, ry - ly);
    const faceH = Math.hypot(chx - fx, chy - fy);
    if (faceW < 8 || faceH < 8) return; // 退化输入（极远 / 极端侧脸）直接丢弃本次测量

    // 额头点(10)在发际线附近，真实头顶还要再往上约 45% 脸高；两侧加头发外扩
    const hrx = faceW * 0.6, hry = faceH * 0.72;
    const ux = Math.sin(rot), uy = -Math.cos(rot);  // 头顶方向
    const ccx = chx + ux * hry, ccy = chy + uy * hry; // 椭圆下沿贴住下巴

    if (!this._init) {
      this.cx = this.ex = ccx; this.cy = this.ey = ccy; this.rx = hrx; this.ry = hry; this.rot = rot;
      this.vx = this.vy = 0; this._init = true;
    } else {
      const dt = Math.max(1e-3, (now - this.t) / 1000);
      // 速度平滑 + 限幅：检测偶发跳变时不会把粒子“打飞”
      const nvx = clamp((ccx - this.cx) / dt, -2500, 2500), nvy = clamp((ccy - this.cy) / dt, -2500, 2500);
      this.vx += (nvx - this.vx) * 0.5; this.vy += (nvy - this.vy) * 0.5;
      const a = 0.65;
      this.cx += (ccx - this.cx) * a; this.cy += (ccy - this.cy) * a;
      this.rx += (hrx - this.rx) * a; this.ry += (hry - this.ry) * a;
      this.rot += (rot - this.rot) * a;
    }
    this.t = now; this.active = true;
  }

  // 手动设置（演示模式：鼠标 / 触摸模拟头部）
  setManual(x, y, r, now) {
    const dt = Math.max(1e-3, (now - this.t) / 1000);
    if (this._init) { this.vx = clamp((x - this.cx) / dt, -2500, 2500) * 0.6 + this.vx * 0.4; this.vy = clamp((y - this.cy) / dt, -2500, 2500) * 0.6 + this.vy * 0.4; }
    this.cx = this.ex = x; this.cy = this.ey = y; this.rx = r * 0.82; this.ry = r; this.rot = 0;
    this.t = now; this.active = true; this._init = true;
  }

  lost() { this.active = false; this._init = false; this.vx = this.vy = 0; }

  // 每个渲染帧调用：短时外推 + 透明度渐变
  tick(dt, now) {
    this.alpha += ((this.active ? 1 : 0) - this.alpha) * Math.min(1, dt * 8);
    if (!this.active) return;
    const since = (now - this.t) / 1000;
    if (since < 0.08) { this.ex = this.cx + this.vx * since; this.ey = this.cy + this.vy * since; }
    else { this.ex = this.cx; this.ey = this.cy; } // 推理卡顿时宁可停住也不乱外推
  }

  get usable() { return this.alpha > 0.5; }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
