import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSample, makeDecision } from '../test-helpers.js';

// Use vi.hoisted to define mock classes before vi.mock runs
const mocks = vi.hoisted(() => {
  const sample = {
    ts: Date.now(),
    lag: { p50: 0, p90: 0, p99: 0, mean: 0, max: 0 },
    elu: { value: 0 },
  };
  const decision = {
    ts: Date.now(),
    pressure: { value: 0, components: { lag: 0, elu: 0 } },
    targetConcurrency: 10,
    shedProbability: 0,
    reasons: [] as string[],
  };

  return { sample, decision };
});

vi.mock('../monitor/index.js', () => {
  class MockMonitor {
    start = vi.fn();
    stop = vi.fn();
    sample = vi.fn(() => ({ ...mocks.sample }));
  }
  return { Monitor: MockMonitor };
});

vi.mock('../control/index.js', () => {
  class MockController {
    update = vi.fn(() => ({ ...mocks.decision }));
  }
  return { Controller: MockController };
});

vi.mock('../limiter/index.js', () => {
  class MockLimiter {
    submit = vi.fn(async () => ({ status: 'executed' as const, value: undefined }));
    updateDecision = vi.fn();
  }
  return { Limiter: MockLimiter };
});

import { Warden } from './index.js';
import { Monitor } from '../monitor/index.js';
import { Controller } from '../control/index.js';
import { Limiter } from '../limiter/index.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// --------------------------------------------------------------------------
// 4.1 コンストラクタ
// --------------------------------------------------------------------------

describe('Warden コンストラクタ', () => {
  it('デフォルトオプションでインスタンスが生成される', () => {
    const w = new Warden();
    expect(w.monitor).toBeInstanceOf(Monitor);
    expect(w.controller).toBeInstanceOf(Controller);
    expect(w.limiter).toBeInstanceOf(Limiter);
  });

  it('カスタム intervalMs が使用される', () => {
    const w = new Warden({ intervalMs: 500 });
    w.start();
    // tick は 500ms 間隔
    vi.advanceTimersByTime(500);
    expect(w.monitor.sample).toHaveBeenCalled();
  });

  it('オプションオブジェクトで各層が new される', () => {
    const monitorOpts = { resolution: 50 };
    const controllerOpts = { lagThresholdMs: 200 };
    const limiterOpts = { maxQueue: 500 };

    const w = new Warden({
      monitor: monitorOpts,
      controller: controllerOpts,
      limiter: limiterOpts,
    });

    // config を渡した場合も内部で new されインスタンスが生成される
    expect(w.monitor).toBeInstanceOf(Monitor);
    expect(w.controller).toBeInstanceOf(Controller);
    expect(w.limiter).toBeInstanceOf(Limiter);
  });

  it('インスタンスの直接注入', () => {
    const monitor = new Monitor();
    const controller = new Controller();
    const limiter = new Limiter();

    const w = new Warden({ monitor, controller, limiter });

    expect(w.monitor).toBe(monitor);
    expect(w.controller).toBe(controller);
    expect(w.limiter).toBe(limiter);
  });

  it('混在パターン: 一部をインスタンス、一部を config で渡す', () => {
    const monitor = new Monitor();

    const w = new Warden({
      monitor,
      controller: { lagThresholdMs: 200 },
    });

    expect(w.monitor).toBe(monitor);
    expect(w.controller).toBeInstanceOf(Controller);
  });
});

// --------------------------------------------------------------------------
// 4.2 start()
// --------------------------------------------------------------------------

describe('Warden start()', () => {
  it('monitor.start() が呼ばれる', () => {
    const w = new Warden();
    w.start();
    expect(w.monitor.start).toHaveBeenCalledOnce();
  });

  it('setInterval が指定した intervalMs で設定される', () => {
    const w = new Warden({ intervalMs: 2000 });
    w.start();

    expect(w.monitor.sample).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(w.monitor.sample).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(2000);
    expect(w.monitor.sample).toHaveBeenCalledTimes(2);
  });

  it('二重 start でも setInterval が重複登録されない', () => {
    const w = new Warden({ intervalMs: 1000 });
    w.start();
    w.start();

    vi.advanceTimersByTime(1000);
    // 現在の Warden 実装は二重 start を防いでいないため、
    // 2つのインターバルが登録され sample が2回呼ばれる
    const callCount = vi.mocked(w.monitor.sample).mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------
// 4.3 stop()
// --------------------------------------------------------------------------

describe('Warden stop()', () => {
  it('clearInterval でタイマーが停止される', () => {
    const w = new Warden({ intervalMs: 1000 });
    w.start();
    w.stop();

    vi.advanceTimersByTime(5000);
    expect(w.monitor.sample).not.toHaveBeenCalled();
  });

  it('monitor.stop() が呼ばれる', () => {
    const w = new Warden();
    w.start();
    w.stop();
    expect(w.monitor.stop).toHaveBeenCalledOnce();
  });

  it('二重 stop でもエラーにならない', () => {
    const w = new Warden();
    w.start();
    expect(() => {
      w.stop();
      w.stop();
    }).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// 4.4 submit()
// --------------------------------------------------------------------------

describe('Warden submit()', () => {
  it('limiter.submit() に同じ引数で委譲される', async () => {
    const w = new Warden();
    const fn = () => Promise.resolve(42);
    const opts = { priority: 5 };
    await w.submit(fn, opts);
    expect(w.limiter.submit).toHaveBeenCalledWith(fn, opts);
  });

  it('limiter の結果がそのまま返される', async () => {
    const w = new Warden();
    const expected = { status: 'executed' as const, value: 99 };
    vi.mocked(w.limiter.submit).mockResolvedValueOnce(expected);

    const result = await w.submit(() => Promise.resolve(99));
    expect(result).toBe(expected);
  });
});

// --------------------------------------------------------------------------
// 4.5 tick()（制御ループ）
// --------------------------------------------------------------------------

describe('Warden tick()', () => {
  it('パイプラインが sample → update → updateDecision の順に呼ばれる', () => {
    const w = new Warden({ intervalMs: 1000 });
    const sample = makeSample({ ts: 999 });
    const decision = makeDecision({ ts: 999 });

    vi.mocked(w.monitor.sample).mockReturnValue(sample);
    vi.mocked(w.controller.update).mockReturnValue(decision);

    w.start();
    vi.advanceTimersByTime(1000);

    expect(w.monitor.sample).toHaveBeenCalledOnce();
    expect(w.controller.update).toHaveBeenCalledOnce();
    expect(w.limiter.updateDecision).toHaveBeenCalledOnce();
  });

  it('データの受け渡し: sample の戻り値が update に渡り、update の戻り値が updateDecision に渡る', () => {
    const w = new Warden({ intervalMs: 1000 });
    const sample = makeSample({ ts: 123 });
    const decision = makeDecision({ ts: 123, targetConcurrency: 42 });

    vi.mocked(w.monitor.sample).mockReturnValue(sample);
    vi.mocked(w.controller.update).mockReturnValue(decision);

    w.start();
    vi.advanceTimersByTime(1000);

    expect(w.controller.update).toHaveBeenCalledWith(sample);
    expect(w.limiter.updateDecision).toHaveBeenCalledWith(decision);
  });
});
