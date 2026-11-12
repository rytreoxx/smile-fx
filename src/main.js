// Smile FX —— 入口：摄像头 / 模型 / 主循环 / 自适应画质 / 边缘情况处理
import { ExpressionFSM, STATE } from './expression.js';
import { HeadCollider } from './head.js';
import { Particles } from './particles.js';
import { createGLRenderer } from './renderer-gl.js';

const $ = (id) => document.getElementById(id);
const video = $('cam'), canvas = $('fx'), overlay = $('overlay');
// 粒子层优先 WebGL（2 次 draw call 画完所有粒子），失败则回退 Canvas2D
// ?canvas2d 可强制走回退路径，用于 A/B 对比两种渲染器的耗时
const glr = new URLSearchParams(location.search).has('canvas2d') ? null : createGLRenderer(canvas);
const ctx = glr ? null : canvas.getContext('2d', { alpha: true });
const octx = overlay.getContext('2d'); // 叠加层：演示模式假头 / 碰撞体可视化，只在需要时重绘
const RENDERER = glr ? 'WebGL' : 'Canvas2D';

// ---------------- 自适应画质 ----------------
// 三档：粒子上限 / 发射倍率 / 画布 DPR 上限。帧时间持续超标自动降档，持续富余再升档。
const QUALITY = [
  { name: 'High', cap: 3500, spawn: 1.0, dpr: 2 },
  { name: 'Mid',  cap: 2200, spawn: 0.7, dpr: 1.5 },
  { name: 'Low',  cap: 1200, spawn: 0.45, dpr: 1 },
];
const isMobile = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
let qLevel = isMobile ? 1 : 0;

const fsm = new ExpressionFSM();
const head = new HeadCollider();
const ps = new Particles();

const S = {
  mode: 'idle',               // idle | camera | demo
  landmarker: null, delegate: '-',
  W: 0, H: 0, dpr: 1,
  map: { ox: 0, oy: 0, dw: 1, dh: 1 },
  lastVideoTime: -1, lastInfer: 0, inferInterval: 33, inferMs: 0, inferHz: 0, inferCount: 0, inferErr: 0, build: null,
  lastFaceAt: 0, faceSeen: false,
  frameEma: 16.7, workMs: 0, overlayDirty: false, overSince: 0, underSince: 0,
  rainAcc: 0, nextRocketAt: 0, prevState: STATE.NEUTRAL,
  fps: 0, frames: 0, fpsT: 0, hitsPerSec: 0,
  showHud: false, showCollider: false, raf: 0, last: 0, dirty: false,
  demo: { forced: null, pointer: null, autoT: 0 },
};
const blend = new Map(); // 复用，避免每帧分配

// ---------------- 模型加载（页面打开即后台开始，与用户阅读说明并行） ----------------
const loadState = $('load-state');
const modelReady = loadModel().catch((e) => { console.error(e); loadState.textContent = '模型加载失败：' + (e.message || e) + '（可进入演示模式）'; throw e; });

async function loadModel() {
  loadState.textContent = '正在加载人脸模型…';
  const { FaceLandmarker, FilesetResolver } = await import('../vendor/mediapipe/vision_bundle.mjs');
  const wasmBase = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
  const [fileset, model] = await Promise.all([
    FilesetResolver.forVisionTasks(wasmBase),
    fetchWithProgress(new URL('../vendor/mediapipe/face_landmarker.task', import.meta.url).href),
  ]);
  const opts = (delegate) => ({
    baseOptions: { modelAssetBuffer: model, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,                        // 直播场景只追主播一张脸：推理成本随人脸数线性增长
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false, // 用不到 3D 矩阵，关掉省计算
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let lm;
  S.build = (delegate) => FaceLandmarker.createFromOptions(fileset, opts(delegate));
  try { lm = await S.build('GPU'); S.delegate = 'GPU'; }
  catch (e) { console.warn('GPU delegate 不可用，回退 CPU', e); lm = await S.build('CPU'); S.delegate = 'CPU'; }
  S.landmarker = lm;
  loadState.textContent = `模型就绪（${S.delegate}）`;
  return lm;
}

async function rebuildCPU() {
  S.delegate = 'CPU…';
  try { S.landmarker = await S.build('CPU'); S.delegate = 'CPU'; S.inferErr = 0; }
  catch (e) { console.error(e); showHint('人脸模型运行失败，请刷新页面或进入演示模式', 0); }
}

async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(); const buf = new Uint8Array(total); let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf.set(value, got); got += value.length;
    loadState.textContent = `正在加载人脸模型… ${Math.round((got / total) * 100)}%`;
  }
  return buf;
}

// ---------------- 摄像头 ----------------
async function startCamera() {
  const btn = $('btn-start'); btn.disabled = true; btn.textContent = '正在请求摄像头权限…';
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return fail('当前页面不是 HTTPS 安全环境或浏览器不支持摄像头 API。请使用 HTTPS 链接，或进入演示模式。');
  }
  let stream;
  // 低分辨率足够做表情识别：640×480@30 相比 1080p，解码 / 上传 GPU / 推理成本都显著更低
  const ideal = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } };
  try { stream = await navigator.mediaDevices.getUserMedia({ video: ideal, audio: false }); }
  catch (e) {
    if (e.name === 'OverconstrainedError') { try { stream = await navigator.mediaDevices.getUserMedia({ video: true }); } catch (e2) { e = e2; } }
    if (!stream) {
      const msg = {
        NotAllowedError: '摄像头权限被拒绝。请在浏览器地址栏的权限设置中允许摄像头后刷新，或进入演示模式。',
        NotFoundError: '没有检测到摄像头设备。可以进入演示模式体验物理特效。',
        NotReadableError: '摄像头被其他应用占用（如会议软件）。关闭后重试，或进入演示模式。',
      }[e.name] || '无法打开摄像头：' + e.message;
      return fail(msg);
    }
  }
  video.srcObject = stream;
  stream.getVideoTracks()[0].addEventListener('ended', () => showHint('摄像头已断开，刷新页面可重新连接', 0));
  await video.play().catch(() => {});
  await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));

  btn.textContent = '正在加载模型…';
  try { await modelReady; } catch { return fail('人脸模型加载失败，请检查网络后刷新，或进入演示模式。'); }
  enter('camera');

  function fail(msg) { btn.disabled = false; btn.textContent = '重试开启摄像头'; loadState.textContent = msg; }
}

function enter(mode) {
  S.mode = mode;
  document.body.classList.toggle('demo', mode === 'demo');
  $('intro').classList.add('hidden');
  for (const id of ['badge', 'meters', 'toolbar']) $(id).classList.remove('hidden');
  fsm.reset(); head.lost(); ps.clear();
  if (mode === 'demo') { fsm.cal.done = true; showHint('演示模式：拖动/移动鼠标控制“头部”<br>按住 <b>1</b> 微笑下雨 · 按住 <b>2</b> 大笑放烟花（手机点底部按钮）<br>不操作时会自动轮播', 4500); addDemoButtons(); }
  resize();
  S.last = performance.now(); S.fpsT = S.last;
  cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(loop);
}

// ---------------- 视口与坐标映射 ----------------
function resize() {
  S.W = innerWidth; S.H = innerHeight;
  S.dpr = Math.min(devicePixelRatio || 1, QUALITY[qLevel].dpr);
  canvas.width = Math.round(S.W * S.dpr); canvas.height = Math.round(S.H * S.dpr);
  overlay.width = canvas.width; overlay.height = canvas.height;
  ps.setViewport(S.W, S.H); ps.cap = QUALITY[qLevel].cap;
  // object-fit: cover 的裁切 + 镜像，必须与 CSS 显示完全一致，否则碰撞体和真实头部对不上
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const sc = Math.max(S.W / vw, S.H / vh);
  S.map.dw = vw * sc; S.map.dh = vh * sc; S.map.ox = (S.W - S.map.dw) / 2; S.map.oy = (S.H - S.map.dh) / 2;
  S.dirty = true;
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 250));
video.addEventListener('resize', resize); // 部分手机旋转后摄像头分辨率会变

const mapFn = (nx, ny, out, o) => { const m = S.map; out[o] = m.ox + (1 - nx) * m.dw; out[o + 1] = m.oy + ny * m.dh; };

// ---------------- 推理 ----------------
function infer(now) {
  const lm = S.landmarker; if (!lm || video.readyState < 2) return;
  // 只在“有新视频帧”且到达推理间隔时推理：渲染可以 60/120Hz，但推理没必要超过摄像头帧率
  if (video.currentTime === S.lastVideoTime || now - S.lastInfer < S.inferInterval) return;
  S.lastVideoTime = video.currentTime; S.lastInfer = now;
  const t0 = performance.now();
  let res;
  try { res = lm.detectForVideo(video, now); S.inferErr = 0; }
  catch (e) {
    // 部分设备 GPU delegate 能创建成功但推理时报错（驱动 / WebGL 上下文丢失）：连续失败 5 次自动重建为 CPU
    console.warn(e);
    if (++S.inferErr >= 5 && S.delegate === 'GPU') { S.landmarker = null; rebuildCPU(); }
    return;
  }
  const ms = performance.now() - t0;
  S.inferMs += (ms - S.inferMs) * 0.1; S.inferCount++;
  // 推理自适应降频：单次推理过慢（低端机 / CPU 回退）时 30Hz → 15Hz，把主线程留给渲染
  S.inferInterval = S.inferMs > 22 ? 66 : S.inferMs < 12 ? 33 : S.inferInterval;

  if (res.faceLandmarks && res.faceLandmarks.length) {
    head.measure(res.faceLandmarks[0], mapFn, now);
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (cats) { for (let i = 0; i < cats.length; i++) blend.set(cats[i].categoryName, cats[i].score); fsm.update(blend, now); }
    S.lastFaceAt = now; S.faceSeen = true;
  } else if (now - S.lastFaceAt > 400) {
    // 人脸丢失超过 400ms：停止触发、碰撞体淡出。短暂丢帧（眨眼 / 遮挡）不打断特效
    head.lost(); fsm.state = STATE.NEUTRAL;
  }
}

// ---------------- 演示模式（无摄像头兜底，保证评审一定能看到物理效果） ----------------
function demoTick(now) {
  const d = S.demo;
  let x, y;
  if (d.pointer && now - d.pointer.t < 3000) { x = d.pointer.x; y = d.pointer.y; }
  else { x = S.W / 2 + Math.sin(now / 900) * S.W * 0.18; y = S.H * 0.55 + Math.sin(now / 1300) * S.H * 0.05; }
  head.setManual(x, y, Math.min(S.W, S.H) * 0.17, now);
  let st = d.forced;
  if (!st) { const ph = ((now / 1000) % 9); st = ph < 1.5 ? STATE.NEUTRAL : ph < 5 ? STATE.SMILE : STATE.LAUGH; }
  fsm.state = st;
  fsm.smile = st === STATE.NEUTRAL ? 0.1 : 0.75; fsm.jaw = st === STATE.LAUGH ? 0.6 : 0.05;
}
function addDemoButtons() {
  if ($('btn-smile')) return;
  const tb = $('toolbar');
  for (const [id, label, st] of [['btn-laugh', '按住=大笑', STATE.LAUGH], ['btn-smile', '按住=微笑', STATE.SMILE]]) {
    const b = document.createElement('button'); b.id = id; b.textContent = label;
    const on = (e) => { e.preventDefault(); S.demo.forced = st; b.classList.add('on'); };
    const off = () => { S.demo.forced = null; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
    tb.prepend(b);
  }
}
addEventListener('pointermove', (e) => { if (S.mode === 'demo' && !e.target.closest('button,label,.toolbar')) S.demo.pointer = { x: e.clientX, y: e.clientY, t: performance.now() }; });
addEventListener('pointerdown', (e) => { if (S.mode === 'demo' && !e.target.closest('button,label')) S.demo.pointer = { x: e.clientX, y: e.clientY, t: performance.now() }; });

// ---------------- 特效调度 ----------------
function effects(dt, now) {
  const st = fsm.state, k = fsm.intensity(), q = QUALITY[qLevel];
  if (st === STATE.SMILE) {
    S.rainAcc += (180 + 950 * k) * q.spawn * dt;  // 雨量随微笑强度连续变化
    const n = S.rainAcc | 0; if (n) { ps.emitRain(n, k); S.rainAcc -= n; }
  } else S.rainAcc = 0;

  if (st === STATE.LAUGH) {
    if (S.prevState !== STATE.LAUGH) {
      // 进入大笑的瞬间直接在头顶上方炸开两朵：不等火箭飞行，把“表情→反馈”延迟压到最低
      const bx = head.usable ? head.ex : S.W / 2, by = head.usable ? head.ey - head.ry * 1.6 : S.H * 0.3;
      ps.explode(bx - S.W * 0.12, Math.max(S.H * 0.12, by), (Math.random() * 8) | 0, 1);
      ps.explode(bx + S.W * 0.12, Math.max(S.H * 0.12, by - 30), (Math.random() * 8) | 0, 1);
      S.nextRocketAt = now + 150;
    }
    if (now >= S.nextRocketAt) {
      ps.launchRocket(k);
      S.nextRocketAt = now + (520 - 360 * k) / q.spawn; // 笑得越大越密集
    }
  }
  S.prevState = st;
}

// ---------------- 主循环 ----------------
function loop(now) {
  S.raf = requestAnimationFrame(loop);
  const rawDt = now - S.last; S.last = now;
  const dt = Math.min(0.05, rawDt / 1000); // 限制 dt：切后台回来时不会因大步长让粒子瞬移穿模

  if (S.mode === 'camera') infer(now); else if (S.mode === 'demo') demoTick(now);
  const w0 = performance.now();
  head.tick(dt, now);
  effects(dt, now);
  ps.update(dt, head);

  // 渲染：没有粒子且上一帧已清空时跳过整帧绘制（静止时 GPU/CPU 开销≈0）
  if (ps.n > 0 || S.dirty) {
    if (glr) glr.render(ps, S.W, S.H, S.dpr);
    else {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); ps.render(ctx);
    }
    S.dirty = ps.n > 0;
  }
  // 叠加层：只有演示模式或打开碰撞体可视化时才画；关闭时清一次即停止
  const needOverlay = S.mode === 'demo' || (S.showCollider && head.alpha > 0.05);
  if (needOverlay || S.overlayDirty) {
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    if (S.mode === 'demo') drawDemoHead();
    if (S.showCollider && head.alpha > 0.05) drawCollider();
    S.overlayDirty = needOverlay;
  }
  S.workMs += (performance.now() - w0 - S.workMs) * 0.05; // 特效“模拟+绘制”的 CPU 耗时（不含推理）

  adaptQuality(rawDt, now);
  ui(now);
}

function drawCollider() {
  octx.save(); octx.globalAlpha = head.alpha; octx.strokeStyle = '#7CFFB2'; octx.lineWidth = 2; octx.setLineDash([6, 6]);
  octx.beginPath(); octx.ellipse(head.ex, head.ey, head.rx, head.ry, head.rot, 0, Math.PI * 2); octx.stroke(); octx.restore();
}
function drawDemoHead() {
  const x = head.ex, y = head.ey, rx = head.rx, ry = head.ry;
  const g = octx.createRadialGradient(x - rx * 0.3, y - ry * 0.3, rx * 0.1, x, y, ry);
  g.addColorStop(0, '#f3d2b5'); g.addColorStop(1, '#b98a6a');
  octx.fillStyle = g; octx.beginPath(); octx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); octx.fill();
  octx.fillStyle = '#2b1d16'; octx.beginPath(); octx.ellipse(x, y - ry * 0.55, rx * 1.02, ry * 0.5, 0, Math.PI, Math.PI * 2); octx.fill();
  octx.fillStyle = '#222';
  octx.beginPath(); octx.arc(x - rx * 0.35, y - ry * 0.05, rx * 0.07, 0, Math.PI * 2); octx.moveTo(x + rx * 0.42, y - ry * 0.05); octx.arc(x + rx * 0.35, y - ry * 0.05, rx * 0.07, 0, Math.PI * 2); octx.fill();
  octx.strokeStyle = '#7a2e2e'; octx.lineWidth = Math.max(2, rx * 0.05); octx.beginPath();
  if (fsm.state === STATE.LAUGH) { octx.fillStyle = '#5a1a1a'; octx.ellipse(x, y + ry * 0.38, rx * 0.32, ry * 0.18, 0, 0, Math.PI); octx.fill(); }
  else if (fsm.state === STATE.SMILE) { octx.arc(x, y + ry * 0.2, rx * 0.35, Math.PI * 0.15, Math.PI * 0.85); octx.stroke(); }
  else { octx.moveTo(x - rx * 0.2, y + ry * 0.4); octx.lineTo(x + rx * 0.2, y + ry * 0.4); octx.stroke(); }
}

function adaptQuality(rawDt, now) {
  if (rawDt > 250) return; // 切后台 / 断点调试造成的异常帧不计入
  S.frameEma += (rawDt - S.frameEma) * 0.05;
  if (S.frameEma > 22) { S.underSince = 0; if (!S.overSince) S.overSince = now; else if (now - S.overSince > 1500 && qLevel < 2) setQuality(qLevel + 1, now); }
  else if (S.frameEma < 17.5) { S.overSince = 0; if (!S.underSince) S.underSince = now; else if (now - S.underSince > 5000 && qLevel > (isMobile ? 1 : 0)) setQuality(qLevel - 1, now); }
  else { S.overSince = S.underSince = 0; }
}
function setQuality(l, now) { qLevel = l; S.overSince = S.underSince = 0; resize(); if (ps.n > ps.cap) ps.n = ps.cap; void now; }

// ---------------- UI（DOM 更新降频到 ~12Hz，避免每帧触发样式计算） ----------------
let uiT = 0;
const LABEL = { neutral: '中性 · 等待表情', smile: '微笑 · 下雨中', laugh: '大笑 · 放烟花！', none: '—' };
function ui(now) {
  S.frames++;
  if (now - S.fpsT >= 1000) { S.fps = (S.frames * 1000) / (now - S.fpsT); S.frames = 0; S.fpsT = now; S.inferHz = S.inferCount; S.inferCount = 0; S.hitsPerSec = ps.hits; ps.hits = 0; }
  if (now - uiT < 80) return; uiT = now;

  const badge = $('badge');
  const noFace = S.mode === 'camera' && !head.active;
  badge.dataset.state = noFace ? 'none' : fsm.state;
  $('badge-text').textContent = noFace ? '未检测到人脸' : fsm.calibrating ? '校准中…' : LABEL[fsm.state];

  if (S.mode === 'camera') {
    if (noFace) showHint(S.faceSeen ? '请把脸放回画面中，并保证光线充足' : '请正对摄像头，保证脸部光线充足', 0);
    else if (fsm.calibrating) showHint('保持自然表情 1 秒，正在校准你的“中性脸”…', 0);
    else hideHintIfSticky();
  }

  const th = fsm.thresholds;
  $('m-smile').style.width = (fsm.smile * 100).toFixed(0) + '%';
  $('m-jaw').style.width = (fsm.jaw * 100).toFixed(0) + '%';
  $('th-smile').style.left = Math.min(99, th.smile * 100) + '%';
  $('th-jaw').style.left = Math.min(99, th.jaw * 100) + '%';

  if (S.showHud) {
    $('hud').textContent =
      `FPS        ${S.fps.toFixed(0)}  (frame ${S.frameEma.toFixed(1)}ms)\n` +
      `Inference  ${S.mode === 'camera' ? S.inferMs.toFixed(1) + 'ms @ ' + S.inferHz + 'Hz  [' + S.delegate + ']' : 'demo'}\n` +
      `FX work    ${S.workMs.toFixed(2)}ms / frame (sim+draw)\n` +
      `Quality    ${QUALITY[qLevel].name}  dpr ${S.dpr.toFixed(2)}  [${RENDERER}]\n` +
      `Particles  ${ps.n} / ${ps.cap}\n` +
      `Head hits  ${S.hitsPerSec}/s\n` +
      `State      ${fsm.state}  k=${fsm.intensity().toFixed(2)}\n` +
      `smile ${fsm.smile.toFixed(2)} (raw ${fsm.rawSmile.toFixed(2)} base ${fsm.base.smile.toFixed(2)})\n` +
      `jaw   ${fsm.jaw.toFixed(2)} (raw ${fsm.rawJaw.toFixed(2)} base ${fsm.base.jaw.toFixed(2)})`;
  }
}

let hintTimer = 0, hintSticky = false;
function showHint(html, ms) {
  const h = $('hint'); if (h.innerHTML !== html) h.innerHTML = html; h.classList.remove('hidden');
  clearTimeout(hintTimer); hintSticky = !ms;
  if (ms) hintTimer = setTimeout(() => h.classList.add('hidden'), ms);
}
function hideHintIfSticky() { if (hintSticky) { $('hint').classList.add('hidden'); hintSticky = false; } }

// ---------------- 生命周期：切后台暂停，回到前台恢复 ----------------
document.addEventListener('visibilitychange', () => {
  if (S.mode === 'idle') return;
  if (document.hidden) { cancelAnimationFrame(S.raf); S.raf = 0; }
  else { S.last = performance.now(); S.fpsT = S.last; S.frames = 0; S.raf = requestAnimationFrame(loop); }
});

// ---------------- 交互绑定 ----------------
$('btn-start').addEventListener('click', startCamera);
$('btn-demo').addEventListener('click', () => enter('demo'));
const toggle = (key, btnId, el) => { S[key] = !S[key]; $(btnId).classList.toggle('on', S[key]); if (el) $(el).classList.toggle('hidden', !S[key]); S.dirty = true; S.overlayDirty = true; };
$('btn-debug').addEventListener('click', () => toggle('showHud', 'btn-debug', 'hud'));
$('btn-collider').addEventListener('click', () => toggle('showCollider', 'btn-collider'));
$('btn-recal').addEventListener('click', () => { if (S.mode === 'camera') { fsm.reset(); } });
$('sens').addEventListener('input', (e) => { fsm.sens = +e.target.value; });
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'd') toggle('showHud', 'btn-debug', 'hud');
  else if (k === 'c') toggle('showCollider', 'btn-collider');
  else if (k === 'r' && S.mode === 'camera') fsm.reset();
  else if (S.mode === 'demo' && (k === '1' || k === '2')) S.demo.forced = k === '1' ? STATE.SMILE : STATE.LAUGH;
});
addEventListener('keyup', (e) => { if (S.mode === 'demo' && (e.key === '1' || e.key === '2')) S.demo.forced = null; });

// URL 参数：?debug 默认打开性能面板与碰撞体（方便评审直接看指标）
if (new URLSearchParams(location.search).has('debug')) { S.showHud = true; S.showCollider = true; $('hud').classList.remove('hidden'); $('btn-debug').classList.add('on'); $('btn-collider').classList.add('on'); }
