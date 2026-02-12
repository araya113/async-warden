import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Stubs hoisted before vi.mock ---
const histogramStub = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  percentile: vi.fn((p: number) => p * 1_000_000), // returns nanoseconds
  mean: 50_000_000,
  max: 200_000_000,
}));

const eluStub = vi.hoisted(() => ({
  utilization: 0.42,
}));

let eluCallCount = 0;

vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn((_opts?: { resolution?: number }) => histogramStub),
  performance: {
    eventLoopUtilization: vi.fn((_prev?: unknown) => {
      eluCallCount++;
      return { ...eluStub };
    }),
  },
}));

import { Monitor } from './index.js';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

beforeEach(() => {
  vi.clearAllMocks();
  eluCallCount = 0;
  // Reset default stub values
  histogramStub.percentile.mockImplementation((p: number) => p * 1_000_000);
  histogramStub.mean = 50_000_000;
  histogramStub.max = 200_000_000;
  eluStub.utilization = 0.42;
});

// --------------------------------------------------------------------------
// 1.1 コンストラクタ
// --------------------------------------------------------------------------

describe('Monitor コンストラクタ', () => {
  it('デフォルト resolution=20 で monitorEventLoopDelay が呼ばれる', () => {
    new Monitor();
    expect(monitorEventLoopDelay).toHaveBeenCalledWith({ resolution: 20 });
  });

  it('カスタム resolution が渡される', () => {
    new Monitor({ resolution: 50 });
    expect(monitorEventLoopDelay).toHaveBeenCalledWith({ resolution: 50 });
  });
});

// --------------------------------------------------------------------------
// 1.2 start()
// --------------------------------------------------------------------------

describe('Monitor start()', () => {
  it('初回呼び出しで histogram.enable() が呼ばれる', () => {
    const m = new Monitor();
    m.start();
    expect(histogramStub.enable).toHaveBeenCalledOnce();
  });

  it('冪等性: 2回連続で呼んでも enable は1回だけ', () => {
    const m = new Monitor();
    m.start();
    m.start();
    expect(histogramStub.enable).toHaveBeenCalledOnce();
  });
});

// --------------------------------------------------------------------------
// 1.3 stop()
// --------------------------------------------------------------------------

describe('Monitor stop()', () => {
  it('開始後の停止で histogram.disable() が呼ばれる', () => {
    const m = new Monitor();
    m.start();
    m.stop();
    expect(histogramStub.disable).toHaveBeenCalledOnce();
  });

  it('冪等性: 未開始状態で呼んでも disable は呼ばれない', () => {
    const m = new Monitor();
    m.stop();
    expect(histogramStub.disable).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// 1.4 sample()
// --------------------------------------------------------------------------

describe('Monitor sample()', () => {
  it('SystemSample の正しい構造を返す', () => {
    const m = new Monitor();
    const s = m.sample();
    expect(s).toHaveProperty('ts');
    expect(s).toHaveProperty('lag.p50');
    expect(s).toHaveProperty('lag.p90');
    expect(s).toHaveProperty('lag.p99');
    expect(s).toHaveProperty('lag.mean');
    expect(s).toHaveProperty('lag.max');
    expect(s).toHaveProperty('elu.value');
  });

  it('ナノ秒→ミリ秒変換が正しい', () => {
    histogramStub.percentile.mockImplementation((p: number) => {
      if (p === 50) return 10_000_000;
      if (p === 90) return 20_000_000;
      if (p === 99) return 30_000_000;
      return 0;
    });
    histogramStub.mean = 15_000_000;
    histogramStub.max = 50_000_000;

    const m = new Monitor();
    const s = m.sample();

    expect(s.lag.p50).toBe(10);
    expect(s.lag.p90).toBe(20);
    expect(s.lag.p99).toBe(30);
    expect(s.lag.mean).toBe(15);
    expect(s.lag.max).toBe(50);
  });

  it('sample() 後に histogram.reset() が呼ばれる', () => {
    const m = new Monitor();
    m.sample();
    expect(histogramStub.reset).toHaveBeenCalledOnce();
  });

  it('ELU の差分計測: eventLoopUtilization(previousElu) が呼ばれる', () => {
    const m = new Monitor();
    // コンストラクタで 1回呼ばれている (previousElu 初期化)
    const callsBefore = vi.mocked(performance.eventLoopUtilization).mock.calls.length;

    m.sample();

    const callsAfter = vi.mocked(performance.eventLoopUtilization).mock.calls;
    // sample() 内で 2回呼ばれる: (1) eventLoopUtilization(previousElu), (2) eventLoopUtilization()
    expect(callsAfter.length - callsBefore).toBe(2);
    // 1回目の呼び出しには前回の ELU が引数として渡される
    expect(callsAfter[callsBefore]!.length).toBe(1); // with previousElu arg
    // 2回目は引数なし（新しい previousElu 取得）
    expect(callsAfter[callsBefore + 1]!.length).toBe(0);
  });

  it('ts が Date.now() の値と一致する', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    const m = new Monitor();
    const s = m.sample();
    expect(s.ts).toBe(1234567890);
    vi.restoreAllMocks();
  });

  it('連続 sample() で previousElu が更新される', () => {
    const mockElu = vi.mocked(performance.eventLoopUtilization);

    const m = new Monitor();
    // コンストラクタで eventLoopUtilization() が呼ばれた（callIndex 0）

    // 1回目の sample
    m.sample();
    // sample 内: eventLoopUtilization(prevElu) + eventLoopUtilization()

    // 2回目の sample
    m.sample();
    // 2回目の sample 内の最初の呼び出しには、1回目 sample で更新された prevElu が渡される

    // コンストラクタ: 1回、sample1: 2回、sample2: 2回 = 計5回
    expect(mockElu).toHaveBeenCalledTimes(5);

    // 2回目 sample の最初の呼び出し（index=3）は引数1つ
    expect(mockElu.mock.calls[3]!.length).toBe(1);
  });
});
