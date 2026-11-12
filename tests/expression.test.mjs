// 运行：node tests/expression.test.mjs
// 验证表情状态机在典型 / 边缘输入下的行为（带随机噪声，模拟真实 blendshape 抖动）
import { ExpressionFSM, STATE } from '../src/expression.js';
import assert from 'node:assert/strict';

function run(seq) {
  const f = new ExpressionFSM(); const b = new Map(); let t = 0; const seen = [];
  for (const [smile, jaw, ms] of seq) {
    const states = new Set();
    for (let k = 0; k < ms; k += 33) {
      const n = () => (Math.random() - 0.5) * 0.08;
      b.set('mouthSmileLeft', smile + n()); b.set('mouthSmileRight', smile + n()); b.set('jawOpen', Math.max(0, jaw + n()));
      t += 33; states.add(f.update(b, t));
    }
    seen.push({ states, end: f.state });
  }
  return { f, seen };
}

for (let trial = 0; trial < 50; trial++) {
  const { f, seen } = run([
    [0.15, 0.05, 1200], // 0 校准：静息脸自带 0.15 的笑
    [0.15, 0.05, 1000], // 1 中性
    [0.12, 0.45, 1500], // 2 说话 / 惊讶：张嘴不笑
    [0.42, 0.05, 1500], // 3 阈值附近抖动
    [0.80, 0.08, 1500], // 4 明确微笑
    [0.70, 0.55, 1500], // 5 大笑
    [0.80, 0.08, 1500], // 6 收嘴回到微笑
    [0.10, 0.05, 1500], // 7 恢复中性
  ]);
  assert.ok(Math.abs(f.base.smile - 0.15) < 0.03, '基线校准');
  assert.ok(!seen[2].states.has(STATE.LAUGH) && !seen[2].states.has(STATE.SMILE), '张嘴不笑不应触发任何特效');
  assert.equal(seen[3].end, STATE.NEUTRAL, '临界抖动不应误触发');
  assert.equal(seen[4].end, STATE.SMILE);
  assert.equal(seen[5].end, STATE.LAUGH);
  assert.equal(seen[6].end, STATE.SMILE);
  assert.equal(seen[7].end, STATE.NEUTRAL);
}

// 校准时用户已在大笑：基线被截断，之后仍能触发
{
  const { f, seen } = run([[0.9, 0.6, 1200], [0.9, 0.6, 1500]]);
  assert.ok(f.base.smile <= 0.35 && f.base.jaw <= 0.2, '基线上限');
  assert.equal(seen[1].end, STATE.LAUGH);
}
console.log('expression FSM: all tests passed (50 noisy trials + edge cases)');
