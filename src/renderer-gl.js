// WebGL 批量渲染器：所有火花 / 火箭 = 1 次 drawArrays(POINTS)，所有雨滴 / 水花 = 1 次 drawArrays(TRIANGLES)。
//
// 为什么从 Canvas2D 换到 WebGL：
//  Canvas2D 每个粒子一次 drawImage，700 粒子在 6x CPU 降速（≈中端手机）下每帧 ~12ms，已吃掉 60fps 预算的 70%；
//  WebGL 把每帧工作变成“往一块预分配的 Float32Array 写顶点 + 2 次 draw call”，CPU 侧只剩线性写内存，
//  发光衰减在片元着色器里算，不再需要预渲染贴图。
//  WebGL 不可用时（极老设备 / 被禁用）自动回退 Canvas2D 路径，功能不变。
import { RAIN, SPLASH, ROCKET, SPARK, PALETTE } from './particles.js';

const VS_PT = `
attribute vec2 a_p; attribute float a_s; attribute vec4 a_c;
uniform vec2 u_res; uniform float u_dpr;
varying vec4 v_c;
void main(){
  vec2 clip = a_p / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_s * u_dpr;
  v_c = a_c;
}`;
const FS_PT = `
precision mediump float;
varying vec4 v_c;
void main(){
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float glow = (1.0 - r); glow *= glow;
  float core = smoothstep(0.35, 0.0, r);
  vec3 col = mix(v_c.rgb, vec3(1.0), core * 0.85);
  float a = (glow + core) * v_c.a;
  gl_FragColor = vec4(col * a, a);          // 预乘 alpha，配合 ONE,ONE 实现加色混合
}`;
const VS_LN = `
attribute vec2 a_p; attribute float a_a;
uniform vec2 u_res;
varying float v_a;
void main(){
  vec2 clip = a_p / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_a = a_a;
}`;
const FS_LN = `
precision mediump float;
varying float v_a;
void main(){ gl_FragColor = vec4(vec3(0.80, 0.93, 1.0) * v_a, v_a); }`;

const MAXV = 5000;

export function createGLRenderer(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const prog = (vs, fs) => {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };
  let pPt, pLn;
  try { pPt = prog(VS_PT, FS_PT); pLn = prog(VS_LN, FS_LN); } catch (e) { console.warn('WebGL shader 失败，回退 Canvas2D', e); return null; }

  // 预分配顶点缓冲：点 7 float（x,y,size,r,g,b,a）；线（四边形 2 三角 = 6 顶点 × 3 float）
  const ptData = new Float32Array(MAXV * 4 * 7); // 火箭含 3 个尾焰点，按 4 倍预留
  const lnData = new Float32Array(MAXV * 6 * 3);
  const ptBuf = gl.createBuffer(), lnBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf); gl.bufferData(gl.ARRAY_BUFFER, ptData.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, lnBuf); gl.bufferData(gl.ARRAY_BUFFER, lnData.byteLength, gl.DYNAMIC_DRAW);

  const L = {
    pt: { p: gl.getAttribLocation(pPt, 'a_p'), s: gl.getAttribLocation(pPt, 'a_s'), c: gl.getAttribLocation(pPt, 'a_c'), res: gl.getUniformLocation(pPt, 'u_res'), dpr: gl.getUniformLocation(pPt, 'u_dpr') },
    ln: { p: gl.getAttribLocation(pLn, 'a_p'), a: gl.getAttribLocation(pLn, 'a_a'), res: gl.getUniformLocation(pLn, 'u_res') },
  };
  const COL = PALETTE.map(([r, g, b]) => [r / 255, g / 255, b / 255]);
  gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.clearColor(0, 0, 0, 0);

  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

  return {
    kind: 'WebGL',
    get lost() { return lost; },
    render(ps, W, H, dpr) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const n = ps.n; if (!n || lost) return;
      const X = ps.x, Y = ps.y, VX = ps.vx, VY = ps.vy, T = ps.type, LF = ps.life, TT = ps.ttl, S = ps.size, C = ps.col;
      const u = ps.unit, base = 16 * Math.max(0.85, u), lw = 0.8 * Math.max(1, u);
      let np = 0, nl = 0;
      for (let i = 0; i < n; i++) {
        const t = T[i];
        if (t === RAIN || t === SPLASH) {
          // 线段扩成四边形（WebGL lineWidth 在多数平台被锁死为 1px，高分屏上雨会细到看不见）
          const k = t === RAIN ? 0.018 : 0.03;
          const x0 = X[i], y0 = Y[i], x1 = x0 - VX[i] * k, y1 = y0 - VY[i] * k;
          let dx = x1 - x0, dy = y1 - y0; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
          const ox = -dy * lw, oy = dx * lw, a0 = t === RAIN ? 0.6 : 0.8, a1 = 0.0;
          let o = nl * 18;
          lnData[o++] = x0 + ox; lnData[o++] = y0 + oy; lnData[o++] = a0;
          lnData[o++] = x0 - ox; lnData[o++] = y0 - oy; lnData[o++] = a0;
          lnData[o++] = x1 + ox; lnData[o++] = y1 + oy; lnData[o++] = a1;
          lnData[o++] = x1 + ox; lnData[o++] = y1 + oy; lnData[o++] = a1;
          lnData[o++] = x0 - ox; lnData[o++] = y0 - oy; lnData[o++] = a0;
          lnData[o++] = x1 - ox; lnData[o++] = y1 - oy; lnData[o++] = a1;
          nl++;
        } else if (t === SPARK) {
          const r = LF[i] / TT[i], c = COL[C[i]]; let o = np * 7;
          ptData[o++] = X[i]; ptData[o++] = Y[i]; ptData[o++] = base * S[i] * (0.5 + r * 0.5);
          ptData[o++] = c[0]; ptData[o++] = c[1]; ptData[o++] = c[2]; ptData[o++] = Math.min(1, r * 1.3);
          np++;
        } else if (t === ROCKET) {
          const c = COL[C[i]];
          for (let k = 0; k < 4; k++) {
            let o = np * 7;
            ptData[o++] = X[i] - VX[i] * 0.012 * k; ptData[o++] = Y[i] - VY[i] * 0.012 * k; ptData[o++] = base * 1.6 * (1 - k * 0.22);
            ptData[o++] = c[0]; ptData[o++] = c[1]; ptData[o++] = c[2]; ptData[o++] = 1 - k * 0.25;
            np++;
          }
        }
      }
      // 雨：普通 alpha 混合（预乘）
      if (nl) {
        gl.useProgram(pLn); gl.uniform2f(L.ln.res, W, H);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, lnBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, lnData.subarray(0, nl * 18));
        gl.enableVertexAttribArray(L.ln.p); gl.vertexAttribPointer(L.ln.p, 2, gl.FLOAT, false, 12, 0);
        gl.enableVertexAttribArray(L.ln.a); gl.vertexAttribPointer(L.ln.a, 1, gl.FLOAT, false, 12, 8);
        gl.drawArrays(gl.TRIANGLES, 0, nl * 6);
        gl.disableVertexAttribArray(L.ln.p); gl.disableVertexAttribArray(L.ln.a);
      }
      // 烟花：加色混合
      if (np) {
        gl.useProgram(pPt); gl.uniform2f(L.pt.res, W, H); gl.uniform1f(L.pt.dpr, dpr);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, ptData.subarray(0, np * 7));
        gl.enableVertexAttribArray(L.pt.p); gl.vertexAttribPointer(L.pt.p, 2, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(L.pt.s); gl.vertexAttribPointer(L.pt.s, 1, gl.FLOAT, false, 28, 8);
        gl.enableVertexAttribArray(L.pt.c); gl.vertexAttribPointer(L.pt.c, 4, gl.FLOAT, false, 28, 12);
        gl.drawArrays(gl.POINTS, 0, np);
        gl.disableVertexAttribArray(L.pt.p); gl.disableVertexAttribArray(L.pt.s); gl.disableVertexAttribArray(L.pt.c);
      }
    },
  };
}
