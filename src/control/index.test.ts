import { describe, it, expect } from 'vitest';
import { Controller } from './index.js';
import { makeSample } from '../test-helpers.js';

// sigmoid helper to verify expected values
function sigmoid(value: number, threshold: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (value - threshold)));
}

// --------------------------------------------------------------------------
// 2.1 コンストラクタ
// --------------------------------------------------------------------------

describe('Controller コンストラクタ', () => {
  it('デフォルトオプションで初期化される', () => {
    const c = new Controller();
    // 初回 update でデフォルト動作を確認（内部 state は private なので出力で検証）
    const d = c.update(makeSample());
    // targetConcurrency は初期値 maxConcurrency(100) から AIMD 操作後の値
    expect(d.targetConcurrency).toBeLessThanOrEqual(100);
    expect(d.targetConcurrency).toBeGreaterThanOrEqual(1);
  });

  it('カスタムオプションで上書きされる', () => {
    const c = new Controller({
      lagThresholdMs: 200,
      eluThreshold: 0.9,
      lagWeight: 0.7,
      eluWeight: 0.3,
      ewmaAlpha: 0.5,
      maxConcurrency: 50,
      minConcurrency: 5,
      increaseStep: 2,
      decreaseFactor: 0.7,
    });
    // 初期 concurrency = maxConcurrency = 50
    // pressure=0 のサンプルを投入 → pressure が 0 から上昇 → multiplicative decrease
    const d = c.update(makeSample());
    expect(d.targetConcurrency).toBeLessThanOrEqual(50);
  });

  it('初期 concurrency が maxConcurrency で設定される', () => {
    const c = new Controller({ maxConcurrency: 42 });
    // 初回 pressure=0 → smoothedPressure = 0.3 * sigmoid(0,100,0.05) > 0 → 上昇
    // concurrency = floor(42 * 0.5) = 21
    const d = c.update(makeSample());
    // 初回は pressure が 0 → ~sigmoid(0,100,0.05) ≈ 0.0067 → raw ≈ 0.0067
    // smoothed = 0.3 * 0.0067 ≈ 0.002 > prev(0) → decrease: floor(42 * 0.5) = 21
    expect(d.targetConcurrency).toBe(21);
  });
});

// --------------------------------------------------------------------------
// 2.2 sigmoid 正規化
// --------------------------------------------------------------------------

describe('Controller sigmoid 正規化', () => {
  it('閾値ちょうどの入力は 0.5 を返す', () => {
    const c = new Controller();
    const d = c.update(makeSample({ lag: { p99: 100 }, elu: { value: 0.8 } }));
    expect(d.pressure.components.lag).toBeCloseTo(0.5, 5);
    expect(d.pressure.components.elu).toBeCloseTo(0.5, 5);
  });

  it('閾値を大きく超える入力は 1.0 に近い', () => {
    const c = new Controller();
    // ELU steepness=10 なので閾値(0.8)から十分離す必要がある
    const d = c.update(makeSample({ lag: { p99: 300 }, elu: { value: 1.5 } }));
    expect(d.pressure.components.lag).toBeGreaterThan(0.99);
    expect(d.pressure.components.elu).toBeGreaterThan(0.99);
  });

  it('閾値を大きく下回る入力は 0.0 に近い', () => {
    const c = new Controller();
    const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    expect(d.pressure.components.lag).toBeLessThan(0.01);
    expect(d.pressure.components.elu).toBeLessThan(0.01);
  });

  it('lag (p99) の steepness=0.05 で正しく正規化される', () => {
    const c = new Controller();
    const d100 = c.update(makeSample({ lag: { p99: 100 } }));
    expect(d100.pressure.components.lag).toBeCloseTo(sigmoid(100, 100, 0.05), 5);

    const c2 = new Controller();
    const d200 = c2.update(makeSample({ lag: { p99: 200 } }));
    expect(d200.pressure.components.lag).toBeCloseTo(sigmoid(200, 100, 0.05), 5);
  });

  it('ELU の steepness=10 で正しく正規化される', () => {
    const c = new Controller();
    const d08 = c.update(makeSample({ elu: { value: 0.8 } }));
    expect(d08.pressure.components.elu).toBeCloseTo(sigmoid(0.8, 0.8, 10), 5);

    const c2 = new Controller();
    const d10 = c2.update(makeSample({ elu: { value: 1.0 } }));
    expect(d10.pressure.components.elu).toBeCloseTo(sigmoid(1.0, 0.8, 10), 5);
  });
});

// --------------------------------------------------------------------------
// 2.3 圧力 (pressure) 計算
// --------------------------------------------------------------------------

describe('Controller 圧力計算', () => {
  it('rawPressure が lagWeight * normalizedLag + eluWeight * normalizedElu で計算される', () => {
    const c = new Controller();
    const d = c.update(makeSample({ lag: { p99: 100 }, elu: { value: 0.8 } }));
    // Both at threshold → 0.5 each
    // rawPressure = 0.5 * 0.5 + 0.5 * 0.5 = 0.5
    // smoothed = 0.3 * 0.5 + 0.7 * 0 = 0.15
    expect(d.pressure.value).toBeCloseTo(0.15, 5);
  });

  it('重み付けの偏り: lagWeight=1, eluWeight=0 の場合 ELU は影響しない', () => {
    const c = new Controller({ lagWeight: 1, eluWeight: 0 });
    const d = c.update(makeSample({ lag: { p99: 100 }, elu: { value: 1.0 } }));
    // rawPressure = 1 * sigmoid(100,100,0.05) + 0 * sigmoid(1.0,0.8,10) = 0.5
    // smoothed = 0.3 * 0.5 = 0.15
    expect(d.pressure.value).toBeCloseTo(0.3 * sigmoid(100, 100, 0.05), 5);
  });

  it('EWMA 平滑化が正しく適用される', () => {
    const c = new Controller({ ewmaAlpha: 0.3 });
    // 高負荷サンプル
    const d1 = c.update(makeSample({ lag: { p99: 200 }, elu: { value: 1.0 } }));
    const raw1 = 0.5 * sigmoid(200, 100, 0.05) + 0.5 * sigmoid(1.0, 0.8, 10);
    const expected1 = 0.3 * raw1; // prev=0
    expect(d1.pressure.value).toBeCloseTo(expected1, 5);

    // 同じサンプルをもう一度 → EWMA 更新
    const d2 = c.update(makeSample({ lag: { p99: 200 }, elu: { value: 1.0 } }));
    const expected2 = 0.3 * raw1 + 0.7 * expected1;
    expect(d2.pressure.value).toBeCloseTo(expected2, 5);
  });

  it('初回更新で初期 smoothedPressure=0 から正しく計算される', () => {
    const c = new Controller();
    const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    const raw = 0.5 * sigmoid(0, 100, 0.05) + 0.5 * sigmoid(0, 0.8, 10);
    expect(d.pressure.value).toBeCloseTo(0.3 * raw, 5);
  });

  it('連続更新での平滑化効果: 急なスパイクが EWMA で緩和される', () => {
    const c = new Controller();
    // 低負荷 x 3
    c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));

    // スパイク
    const spike = c.update(makeSample({ lag: { p99: 300 }, elu: { value: 1.0 } }));
    // EWMA により急激には追従しない
    expect(spike.pressure.value).toBeLessThan(0.5);
  });
});

// --------------------------------------------------------------------------
// 2.4 AIMD 制御
// --------------------------------------------------------------------------

describe('Controller AIMD 制御', () => {
  it('Multiplicative Decrease: pressure 上昇時に floor(concurrency * decreaseFactor)', () => {
    const c = new Controller({ maxConcurrency: 100, decreaseFactor: 0.5 });
    // 初回: pressure 0→>0 (上昇) → decrease
    const d = c.update(makeSample({ lag: { p99: 200 }, elu: { value: 1.0 } }));
    expect(d.targetConcurrency).toBe(Math.floor(100 * 0.5)); // 50
  });

  it('Additive Increase: pressure 低下時に concurrency += increaseStep', () => {
    const c = new Controller({ maxConcurrency: 100, increaseStep: 1, decreaseFactor: 0.5 });
    // 1回目: pressure上昇 → decrease: floor(100*0.5)=50
    c.update(makeSample({ lag: { p99: 200 }, elu: { value: 1.0 } }));
    // 2回目: 同じサンプル → smoothed は上昇するが、もう一度低負荷にして下降させる
    // 低負荷にする → smoothedPressure が下がる → additive increase
    // 低負荷を複数回投入して pressure を下げる
    c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    expect(d.reasons).toContain('pressure falling: additive increase');
  });

  it('上限クランプ: concurrency が maxConcurrency を超えない', () => {
    const c = new Controller({ maxConcurrency: 10, increaseStep: 100 });
    // 低負荷を大量に投入しても max を超えない
    // まず上げてから下げる
    c.update(makeSample({ lag: { p99: 200 }, elu: { value: 1.0 } }));
    // 低負荷で increase
    for (let i = 0; i < 20; i++) {
      c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    }
    const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    expect(d.targetConcurrency).toBeLessThanOrEqual(10);
  });

  it('下限クランプ: concurrency が minConcurrency を下回らない', () => {
    const c = new Controller({ maxConcurrency: 100, minConcurrency: 5, decreaseFactor: 0.5 });
    // 高負荷を連続して投入し concurrency を下げ続ける
    for (let i = 0; i < 20; i++) {
      c.update(makeSample({ lag: { p99: 300 }, elu: { value: 1.0 } }));
    }
    const d = c.update(makeSample({ lag: { p99: 300 }, elu: { value: 1.0 } }));
    expect(d.targetConcurrency).toBeGreaterThanOrEqual(5);
  });

  it('pressure 変化なしの場合は Additive Increase が適用される', () => {
    // smoothedPressure == previousSmoothedPressure → else 分岐 → increase
    // ewmaAlpha=1 にすると smoothedPressure = rawPressure になる
    // 同じサンプルを2回投入すれば 2回目は smoothed == prev → increase
    const c = new Controller({ ewmaAlpha: 1.0 });
    // 1回目: smoothed = raw, prev = 0 → smoothed > prev → decrease
    c.update(makeSample({ lag: { p99: 100 }, elu: { value: 0.8 } }));
    // 2回目: 同じ入力 → raw は同じ → smoothed = raw == prev → else → increase
    const d = c.update(makeSample({ lag: { p99: 100 }, elu: { value: 0.8 } }));
    expect(d.reasons).toContain('pressure falling: additive increase');
  });

  it('連続 decrease: pressure が上昇し続けると急速に concurrency が下がる', () => {
    const c = new Controller({ maxConcurrency: 100, decreaseFactor: 0.5 });
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = c.update(makeSample({ lag: { p99: 300 }, elu: { value: 1.0 } }));
      results.push(d.targetConcurrency);
    }
    // 各ステップで半減していく
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!).toBeLessThanOrEqual(results[i - 1]!);
    }
    // 最終値は十分小さい
    expect(results[results.length - 1]!).toBeLessThan(10);
  });

  it('decrease 後の increase: pressure が下がり始めたら段階的に回復する', () => {
    const c = new Controller({ maxConcurrency: 100, decreaseFactor: 0.5, increaseStep: 1 });
    // 高負荷で concurrency を下げる
    for (let i = 0; i < 5; i++) {
      c.update(makeSample({ lag: { p99: 300 }, elu: { value: 1.0 } }));
    }
    const afterDecrease = c.update(makeSample({ lag: { p99: 300 }, elu: { value: 1.0 } }));

    // 低負荷に切り替え → pressure 低下 → increase
    let prev = afterDecrease.targetConcurrency;
    for (let i = 0; i < 10; i++) {
      const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
      if (d.reasons.includes('pressure falling: additive increase')) {
        expect(d.targetConcurrency).toBeGreaterThanOrEqual(prev);
        prev = d.targetConcurrency;
      }
    }
    expect(prev).toBeGreaterThan(afterDecrease.targetConcurrency);
  });
});

// --------------------------------------------------------------------------
// 2.5 Shedding 確率
// --------------------------------------------------------------------------

describe('Controller shedding 確率', () => {
  it('pressure <= 0.5 で shedProbability が 0', () => {
    const c = new Controller();
    // 低負荷 → pressure ≈ 0
    const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    expect(d.shedProbability).toBe(0);
  });

  it('pressure = 0.75 で shedProbability が 0.5', () => {
    // shedProbability = (pressure - 0.5) / (1 - 0.5) = (0.75 - 0.5) / 0.5 = 0.5
    // We need smoothedPressure=0.75 exactly.
    // Use ewmaAlpha=1 so smoothedPressure = rawPressure immediately
    // rawPressure = lagWeight*normLag + eluWeight*normElu
    // Need raw = 0.75. With equal weights (0.5, 0.5): normLag + normElu = 1.5
    // If we set lagWeight=1, eluWeight=0, then raw = normLag = 0.75
    // sigmoid(x, 100, 0.05) = 0.75 → solve: -0.05*(x-100) = ln(1/0.75 - 1) = ln(1/3)
    // x = 100 - ln(1/3)/0.05 ≈ 100 + 21.97 ≈ 121.97
    const lagP99 = 100 - Math.log(1 / 0.75 - 1) / 0.05;
    const c = new Controller({ ewmaAlpha: 1.0, lagWeight: 1, eluWeight: 0 });
    const d = c.update(makeSample({ lag: { p99: lagP99 } }));
    expect(d.pressure.value).toBeCloseTo(0.75, 3);
    expect(d.shedProbability).toBeCloseTo(0.5, 3);
  });

  it('pressure >= 1.0 で shedProbability が 1.0', () => {
    // ewmaAlpha=1, extremely high pressure
    const c = new Controller({ ewmaAlpha: 1.0 });
    const d = c.update(makeSample({ lag: { p99: 1000 }, elu: { value: 2.0 } }));
    expect(d.shedProbability).toBeCloseTo(1.0, 2);
  });

  it('線形補間の正確性', () => {
    // smoothedPressure=0.6 → shed = (0.6-0.5)/(1-0.5) = 0.2
    const lagP99 = 100 - Math.log(1 / 0.6 - 1) / 0.05;
    const c = new Controller({ ewmaAlpha: 1.0, lagWeight: 1, eluWeight: 0 });
    const d = c.update(makeSample({ lag: { p99: lagP99 } }));
    expect(d.pressure.value).toBeCloseTo(0.6, 3);
    expect(d.shedProbability).toBeCloseTo(0.2, 3);
  });
});

// --------------------------------------------------------------------------
// 2.6 reasons
// --------------------------------------------------------------------------

describe('Controller reasons', () => {
  it('pressure 上昇時に "pressure rising: multiplicative decrease" が含まれる', () => {
    const c = new Controller();
    const d = c.update(makeSample({ lag: { p99: 200 }, elu: { value: 1.0 } }));
    expect(d.reasons).toContain('pressure rising: multiplicative decrease');
  });

  it('pressure 低下時に "pressure falling: additive increase" が含まれる', () => {
    const c = new Controller();
    // 1回目: 上昇
    c.update(makeSample({ lag: { p99: 200 }, elu: { value: 1.0 } }));
    // 低負荷で下降
    const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 0 } }));
    // smoothed は下がるとは限らない（EWMA で前の値が残る）。
    // 2回目の raw は低い → smoothed = alpha * low_raw + (1-alpha) * prev
    // prev > low_raw なので smoothed < prev → 下降 → increase
    expect(d.reasons).toContain('pressure falling: additive increase');
  });

  it('lag 優勢時に "dominant signal: lag" が含まれる', () => {
    const c = new Controller();
    // 高 lag, 低 ELU
    const d = c.update(makeSample({ lag: { p99: 200 }, elu: { value: 0 } }));
    expect(d.reasons).toContain('dominant signal: lag');
  });

  it('ELU 優勢時に "dominant signal: elu" が含まれる', () => {
    const c = new Controller();
    // 低 lag, 高 ELU
    const d = c.update(makeSample({ lag: { p99: 0 }, elu: { value: 1.0 } }));
    expect(d.reasons).toContain('dominant signal: elu');
  });

  it('lag == ELU のとき dominant signal の reason が含まれない', () => {
    const c = new Controller();
    // 両方を閾値ちょうどにする → sigmoid は両方とも 0.5
    const d = c.update(makeSample({ lag: { p99: 100 }, elu: { value: 0.8 } }));
    expect(d.reasons).not.toContain('dominant signal: lag');
    expect(d.reasons).not.toContain('dominant signal: elu');
  });
});

// --------------------------------------------------------------------------
// 2.7 ControlDecision の出力構造
// --------------------------------------------------------------------------

describe('Controller ControlDecision 出力構造', () => {
  it('正しい型構造を持つ', () => {
    const c = new Controller();
    const d = c.update(makeSample());
    expect(d).toHaveProperty('ts');
    expect(d).toHaveProperty('pressure.value');
    expect(d).toHaveProperty('pressure.components.lag');
    expect(d).toHaveProperty('pressure.components.elu');
    expect(d).toHaveProperty('targetConcurrency');
    expect(d).toHaveProperty('shedProbability');
    expect(d).toHaveProperty('reasons');
    expect(typeof d.ts).toBe('number');
    expect(typeof d.pressure.value).toBe('number');
    expect(typeof d.pressure.components.lag).toBe('number');
    expect(typeof d.pressure.components.elu).toBe('number');
    expect(typeof d.targetConcurrency).toBe('number');
    expect(typeof d.shedProbability).toBe('number');
    expect(Array.isArray(d.reasons)).toBe(true);
  });

  it('ts が入力 sample の ts と一致する', () => {
    const c = new Controller();
    const sample = makeSample({ ts: 1234567890 });
    const d = c.update(sample);
    expect(d.ts).toBe(1234567890);
  });
});
