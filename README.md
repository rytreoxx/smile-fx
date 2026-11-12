# Smile FX · 直播间表情 AR 互动原型

> 2027 TikTok Design 礼物与效果（AI 产品设计）笔试 · Part 2 Vibe Coding

**微笑 → 屏幕下雨；大笑 → 烟花炸开；雨滴与烟花粒子会和你的头部发生物理碰撞。**

- Live Demo：见仓库描述 / 答卷中的链接（需 HTTPS 才能调用摄像头）
- 加 `?debug` 参数可直接打开性能面板与头部碰撞体可视化，例如 `https://<demo>/?debug`
- 没有摄像头 / 拒绝授权时，可进入「演示模式」：鼠标或手指控制“头部”，按住 1 / 2 键（或底部按钮）触发微笑 / 大笑

## 运行

纯静态页面，无构建步骤、无第三方 CDN 依赖（MediaPipe 运行时与模型已放在 `vendor/`）：

```bash
python -m http.server 8080      # 或任意静态服务器
# 打开 http://localhost:8080  （localhost 属于安全上下文，可直接调用摄像头）
```

## 架构

```
Camera 640×480@30 ──► FaceLandmarker (GPU delegate, VIDEO mode, 1 face, blendshapes)
                          │  ≤30Hz，仅在有新视频帧时推理；单次 >22ms 自动降到 15Hz
            ┌─────────────┴──────────────┐
   blendshapes (smile / jawOpen)    4 个关键点 (两颊/额头/下巴)
            ▼                              ▼
   ExpressionFSM                      HeadCollider
   个人基线校准 → EMA → 双阈值迟滞      旋转椭圆（含头发外扩）+ 速度外推
   NEUTRAL / SMILE / LAUGH                 │
            └──────────────┬───────────────┘
                           ▼
          Emitters（雨量 / 烟花密度随表情强度连续变化）
                           ▼
          Particles：SoA TypedArray 池（零 GC）+ 椭圆碰撞 O(N)
                           ▼
          WebGL 批渲染：全部粒子 2 次 draw call（失败回退 Canvas2D）
```

| 文件 | 职责 |
| --- | --- |
| `src/main.js` | 摄像头、模型加载、主循环、推理调度、自适应画质、边缘情况处理、UI |
| `src/expression.js` | 表情状态机：校准、平滑、迟滞、"笑 + 张嘴" 语义约束 |
| `src/head.js` | 头部碰撞体拟合与外推 |
| `src/particles.js` | 粒子池、发射器、物理与碰撞响应、Canvas2D 回退渲染 |
| `src/renderer-gl.js` | WebGL 批渲染器 |

## 性能（ROI）设计

| 决策 | 收益 |
| --- | --- |
| 摄像头只要 640×480@30 | 识别表情不需要 1080p；解码、纹理上传、推理输入都更小 |
| 视频由 `<video>` + CSS 镜像直接合成，不画进 canvas | 省掉每帧一次全屏纹理拷贝 |
| 推理与渲染解耦：≤30Hz，且仅在新视频帧到达时推理 | 120Hz 屏上不会每帧白跑一次模型 |
| 推理耗时自适应降频（>22ms → 15Hz） | 低端机 / CPU 回退时把主线程留给渲染 |
| `numFaces: 1`，关闭 transformation matrix 输出 | 只算需要的东西 |
| 头部用旋转椭圆碰撞而非网格碰撞 | 碰撞从 O(N·M) 降到 O(N)，外接圆粗筛后绝大多数粒子不做变换 |
| SoA Float32Array 粒子池 + swap-remove | 运行期零对象分配，无 GC 卡顿尖刺 |
| WebGL 批渲染（POINTS + TRIANGLES，2 次 draw call） | 见下方实测 |
| 自适应画质三档（粒子上限 / 发射倍率 / DPR 上限） | 帧时间持续 >22ms 自动降档，富余 5s 再升档 |
| 空闲帧跳过绘制、切后台暂停主循环 | 没有特效时功耗≈0 |

**实测（Chrome headless，模拟 390×844@3x 手机 + 6 倍 CPU 降速，演示模式持续大笑）：**

| 渲染器 | 粒子数 | 特效每帧 CPU 耗时（模拟 + 绘制） | 自适应画质 |
| --- | --- | --- | --- |
| Canvas2D（逐粒子 drawImage） | 400–930 | 6–12 ms | 自动降到 Low |
| **WebGL 批渲染** | 550–830 | **0.8–1.4 ms** | 保持 Mid |

摄像头模式（桌面 GPU）：FaceLandmarker 推理 6–8 ms @ 30Hz，特效耗时约 0.1 ms / 帧。

## 边缘情况

| 场景 | 处理 |
| --- | --- |
| 静息脸本身带笑 | 进入后采集 1s 个人基线；基线有上限，防止校准时就在大笑导致永远无法触发 |
| 说话 / 惊讶 / 打哈欠（张嘴不笑） | 大笑必须"笑 + 张嘴"同时成立，不会误放烟花（单测覆盖） |
| 阈值临界抖动 | EMA + 双阈值迟滞 + 最短保持时间（进入 140ms / 退出 260ms） |
| 大笑时嘴角被拉平导致 smile 下降 | 退出大笑使用更宽松的 smile 下限 |
| 人脸短暂丢失（眨眼、手挡） | 400ms 内不打断；超时后停止触发，碰撞体淡出，粒子不会撞到"幽灵头" |
| 推理卡顿 | 碰撞体外推最多 80ms，超时停住不乱飞；dt 上限 50ms 防止穿模 |
| 摄像头被拒 / 不存在 / 被占用 / 非 HTTPS | 分别给出明确提示，并提供演示模式 |
| 分辨率约束不支持 | `OverconstrainedError` 时降级为 `video: true` 重试 |
| GPU delegate 不可用或运行时报错 | 创建失败回退 CPU；运行中连续 5 次失败自动重建为 CPU |
| WebGL 不可用 | 回退 Canvas2D 渲染路径 |
| 横竖屏切换 / 窗口缩放 / 摄像头分辨率变化 | 重新计算 object-fit: cover 映射，碰撞体与画面对齐 |
| 切后台 | 暂停主循环；回到前台重置计时，不会出现大步长 |
| iOS Safari | `playsinline muted`，用户点击后才启动摄像头 |

## 隐私

画面只在本机浏览器内处理，不上传、不存储。

## 第三方

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe)（Apache-2.0），`vendor/mediapipe/` 下为未修改的运行时、wasm 与 `face_landmarker.task` 模型。
