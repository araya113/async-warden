import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Limiter } from './index.js';
import { makeDecision, deferred } from '../test-helpers.js';

beforeEach(() => {
  vi.spyOn(Math, 'random');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------------
// 3.1 コンストラクタ
// --------------------------------------------------------------------------

describe('Limiter コンストラクタ', () => {
  it('デフォルト maxQueue が 1000', async () => {
    // maxQueue は private だが、キュー溢れ動作で間接検証
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 0, shedProbability: 0 }));

    // 1000個キューに入れられる
    for (let i = 0; i < 1000; i++) {
      limiter.submit(() => Promise.resolve(i));
    }
    // 1001個目は queue_overflow
    const result = await limiter.submit(() => Promise.resolve('overflow'));
    expect(result).toEqual({ status: 'shed', reason: 'queue_overflow' });
  });

  it('カスタム maxQueue が設定される', async () => {
    const limiter = new Limiter({ maxQueue: 2 });
    limiter.updateDecision(makeDecision({ targetConcurrency: 0, shedProbability: 0 }));

    // 2個はキューに入る
    limiter.submit(() => Promise.resolve(1));
    limiter.submit(() => Promise.resolve(2));
    // 3個目は overflow
    const result = await limiter.submit(() => Promise.resolve(3));
    expect(result).toEqual({ status: 'shed', reason: 'queue_overflow' });
  });
});

// --------------------------------------------------------------------------
// 3.2 decision 未設定時の動作
// --------------------------------------------------------------------------

describe('Limiter decision 未設定時', () => {
  it('updateDecision 未呼出時に submit すると制限なしで即時実行される', async () => {
    const limiter = new Limiter();
    const result = await limiter.submit(() => Promise.resolve(42));
    expect(result).toEqual({ status: 'executed', value: 42 });
  });

  it('結果の型が { status: "executed", value } である', async () => {
    const limiter = new Limiter();
    const result = await limiter.submit(() => Promise.resolve('hello'));
    expect(result.status).toBe('executed');
    if (result.status === 'executed') {
      expect(result.value).toBe('hello');
    }
  });
});

// --------------------------------------------------------------------------
// 3.3 確率的 shedding
// --------------------------------------------------------------------------

describe('Limiter 確率的 shedding', () => {
  it('shedProbability=1.0 で必ず shed される', async () => {
    const limiter = new Limiter();
    vi.mocked(Math.random).mockReturnValue(0.5);
    limiter.updateDecision(makeDecision({ shedProbability: 1.0, targetConcurrency: 100 }));
    const result = await limiter.submit(() => Promise.resolve('x'));
    expect(result).toEqual({ status: 'shed', reason: 'probabilistic_shedding' });
  });

  it('shedProbability=0 で shedding が発生しない', async () => {
    const limiter = new Limiter();
    vi.mocked(Math.random).mockReturnValue(0.99);
    limiter.updateDecision(makeDecision({ shedProbability: 0, targetConcurrency: 100 }));
    const result = await limiter.submit(() => Promise.resolve('x'));
    expect(result).toEqual({ status: 'executed', value: 'x' });
  });

  it('Math.random() < shedProbability のロジックが正しい', async () => {
    const limiter = new Limiter();
    // random=0.3, shedProb=0.5 → 0.3 < 0.5 → shed
    vi.mocked(Math.random).mockReturnValue(0.3);
    limiter.updateDecision(makeDecision({ shedProbability: 0.5, targetConcurrency: 100 }));
    const shedded = await limiter.submit(() => Promise.resolve('x'));
    expect(shedded.status).toBe('shed');

    // random=0.7, shedProb=0.5 → 0.7 >= 0.5 → not shed
    vi.mocked(Math.random).mockReturnValue(0.7);
    const executed = await limiter.submit(() => Promise.resolve('y'));
    expect(executed.status).toBe('executed');
  });

  it('shed 理由が "probabilistic_shedding" である', async () => {
    const limiter = new Limiter();
    vi.mocked(Math.random).mockReturnValue(0);
    limiter.updateDecision(makeDecision({ shedProbability: 1.0, targetConcurrency: 100 }));
    const result = await limiter.submit(() => Promise.resolve('x'));
    expect(result).toEqual({ status: 'shed', reason: 'probabilistic_shedding' });
  });
});

// --------------------------------------------------------------------------
// 3.4 Concurrency 制御
// --------------------------------------------------------------------------

describe('Limiter concurrency 制御', () => {
  it('空きスロットありなら即時実行される', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 10, shedProbability: 0 }));
    const result = await limiter.submit(() => Promise.resolve('fast'));
    expect(result).toEqual({ status: 'executed', value: 'fast' });
  });

  it('スロット満杯ならキューに入る', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const d1 = deferred<string>();
    const p1 = limiter.submit(() => d1.promise);

    // 2個目はキューに入り待機する
    let task2Resolved = false;
    const p2 = limiter.submit(() => Promise.resolve('queued')).then((r) => {
      task2Resolved = true;
      return r;
    });

    // まだ task2 は解決していない
    await Promise.resolve(); // microtask flush
    expect(task2Resolved).toBe(false);

    // task1 を完了させると task2 が drain される
    d1.resolve('done');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ status: 'executed', value: 'done' });
    expect(r2).toEqual({ status: 'executed', value: 'queued' });
  });

  it('タスク完了でスロット解放されキューから次が実行される', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const d1 = deferred<string>();
    const p1 = limiter.submit(() => d1.promise);
    const p2 = limiter.submit(() => Promise.resolve('second'));

    d1.resolve('first');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ status: 'executed', value: 'first' });
    expect(r2).toEqual({ status: 'executed', value: 'second' });
  });

  it('キュー復帰後の shedding スキップ: キュー待機から復帰したタスクは必ず実行される', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const d1 = deferred<string>();
    const p1 = limiter.submit(() => d1.promise);

    // 2個目を投入（shedProbability=0 なので通過してキューに入る）
    vi.mocked(Math.random).mockReturnValue(0.99);
    const p2 = limiter.submit(() => Promise.resolve('from-queue'));

    // shedProbability を上げてもキューから復帰したタスクは shedding されない
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 1.0 }));
    vi.mocked(Math.random).mockReturnValue(0);

    d1.resolve('first');
    const [, r2] = await Promise.all([p1, p2]);
    expect(r2).toEqual({ status: 'executed', value: 'from-queue' });
  });
});

// --------------------------------------------------------------------------
// 3.5 キュー管理
// --------------------------------------------------------------------------

describe('Limiter キュー管理', () => {
  it('キュー溢れ shedding: queue_overflow が返される', async () => {
    const limiter = new Limiter({ maxQueue: 1 });
    limiter.updateDecision(makeDecision({ targetConcurrency: 0, shedProbability: 0 }));

    // targetConcurrency=0 なので全てキューに入る
    limiter.submit(() => Promise.resolve(1)); // キュー 1/1
    const result = await limiter.submit(() => Promise.resolve(2)); // overflow
    expect(result).toEqual({ status: 'shed', reason: 'queue_overflow' });
  });

  it('同一 priority のタスクは投入順 (FIFO) に実行される', async () => {
    const limiter = new Limiter();
    // targetConcurrency=1 で順次実行
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const order: number[] = [];
    const blocker = deferred<void>();

    // 1個目がスロットを占有
    const p0 = limiter.submit(async () => { await blocker.promise; order.push(0); });

    // 同一 priority でキューに追加（targetConcurrency=1 なのでキュー待ち）
    const p1 = limiter.submit(async () => { order.push(1); });
    const p2 = limiter.submit(async () => { order.push(2); });
    const p3 = limiter.submit(async () => { order.push(3); });

    // blocker を解除 → task0 完了 → drain で task1 → task1 完了 → drain で task2 → ...
    blocker.resolve();
    await Promise.all([p0, p1, p2, p3]);

    // FIFO 順で実行される
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('高 priority のタスクが先に実行される', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const order: string[] = [];
    const blocker = deferred<void>();

    // スロットを占有
    const p0 = limiter.submit(async () => { await blocker.promise; });

    // 低→高の順でキューに追加
    const pLow = limiter.submit(async () => { order.push('low'); }, { priority: 1 });
    const pHigh = limiter.submit(async () => { order.push('high'); }, { priority: 10 });

    // concurrency を上げて drain
    limiter.updateDecision(makeDecision({ targetConcurrency: 10, shedProbability: 0 }));
    blocker.resolve();
    await Promise.all([p0, pLow, pHigh]);

    expect(order).toEqual(['high', 'low']);
  });

  it('中間 priority のタスクが正しい位置に挿入される', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const order: string[] = [];
    const blocker = deferred<void>();

    const p0 = limiter.submit(async () => { await blocker.promise; });

    const pLow = limiter.submit(async () => { order.push('low'); }, { priority: 1 });
    const pHigh = limiter.submit(async () => { order.push('high'); }, { priority: 10 });
    const pMid = limiter.submit(async () => { order.push('mid'); }, { priority: 5 });

    limiter.updateDecision(makeDecision({ targetConcurrency: 10, shedProbability: 0 }));
    blocker.resolve();
    await Promise.all([p0, pLow, pHigh, pMid]);

    expect(order).toEqual(['high', 'mid', 'low']);
  });
});

// --------------------------------------------------------------------------
// 3.6 drain()
// --------------------------------------------------------------------------

describe('Limiter drain()', () => {
  it('タスク完了時にキューのタスクが起こされる', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const d1 = deferred<void>();
    const p1 = limiter.submit(() => d1.promise);
    const p2 = limiter.submit(() => Promise.resolve('drained'));

    d1.resolve();
    const [, r2] = await Promise.all([p1, p2]);
    expect(r2).toEqual({ status: 'executed', value: 'drained' });
  });

  it('updateDecision 呼び出しでキューのタスクが起こされる', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const blocker = deferred<void>();
    const p0 = limiter.submit(() => blocker.promise);
    const p1 = limiter.submit(() => Promise.resolve('queued'));

    // concurrency を上げて drain を発火
    limiter.updateDecision(makeDecision({ targetConcurrency: 10, shedProbability: 0 }));

    blocker.resolve();
    const [, r1] = await Promise.all([p0, p1]);
    expect(r1).toEqual({ status: 'executed', value: 'queued' });
  });

  it('concurrency 上限遵守: drain で起こすタスク数が targetConcurrency - running を超えない', async () => {
    const limiter = new Limiter();
    // targetConcurrency=1 でタスクを順次実行させる
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const order: string[] = [];
    const blocker = deferred<void>();

    // task0: スロット占有
    const p0 = limiter.submit(async () => { await blocker.promise; order.push('a'); });
    // task1, task2: キュー待ち
    const p1 = limiter.submit(async () => { order.push('b'); });
    const p2 = limiter.submit(async () => { order.push('c'); });

    // blocker 解除 → task0 完了 → drain(1スロット空き) → task1 実行 → drain → task2 実行
    blocker.resolve();
    await Promise.all([p0, p1, p2]);

    // targetConcurrency=1 なので順次実行される
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('decision 未設定時の drain は何もしない', async () => {
    // decision=null のとき drain は早期リターン
    const limiter = new Limiter();
    // submit すると decision=null なので execute が直接呼ばれる（drain は空振り）
    const result = await limiter.submit(() => Promise.resolve('ok'));
    expect(result).toEqual({ status: 'executed', value: 'ok' });
  });

  it('drain のマイクロタスク順序: targetConcurrency 分のタスクが一度に resolve される', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const blocker = deferred<void>();
    const p0 = limiter.submit(() => blocker.promise);

    // 3つキューに入れる
    const resolved: number[] = [];
    const p1 = limiter.submit(async () => { resolved.push(1); });
    const p2 = limiter.submit(async () => { resolved.push(2); });
    const p3 = limiter.submit(async () => { resolved.push(3); });

    // targetConcurrency を 4 に上げて全部 drain
    limiter.updateDecision(makeDecision({ targetConcurrency: 4, shedProbability: 0 }));

    blocker.resolve();
    await Promise.all([p0, p1, p2, p3]);

    // 全て resolve されている
    expect(resolved).toEqual([1, 2, 3]);
  });
});

// --------------------------------------------------------------------------
// 3.7 execute()
// --------------------------------------------------------------------------

describe('Limiter execute()', () => {
  it('タスクの戻り値が { status: "executed", value } で返される', async () => {
    const limiter = new Limiter();
    const result = await limiter.submit(() => Promise.resolve({ data: 123 }));
    expect(result).toEqual({ status: 'executed', value: { data: 123 } });
  });

  it('タスクが例外を投げた場合、例外が伝播する', async () => {
    const limiter = new Limiter();
    await expect(
      limiter.submit(() => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
  });

  it('タスク例外後も running カウントがデクリメントされ次のタスクが実行できる', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    // 1個目は例外
    await expect(
      limiter.submit(() => Promise.reject(new Error('fail')))
    ).rejects.toThrow('fail');

    // 2個目は正常実行できる（running がデクリメントされている）
    const result = await limiter.submit(() => Promise.resolve('ok'));
    expect(result).toEqual({ status: 'executed', value: 'ok' });
  });
});

// --------------------------------------------------------------------------
// 3.8 updateDecision()
// --------------------------------------------------------------------------

describe('Limiter updateDecision()', () => {
  it('新しい decision が内部に保存される', async () => {
    const limiter = new Limiter();
    // decision=null → submit で制限なし実行
    const r1 = await limiter.submit(() => Promise.resolve(1));
    expect(r1.status).toBe('executed');

    // decision を設定し shedProbability=1 → shed
    vi.mocked(Math.random).mockReturnValue(0);
    limiter.updateDecision(makeDecision({ shedProbability: 1.0, targetConcurrency: 100 }));
    const r2 = await limiter.submit(() => Promise.resolve(2));
    expect(r2.status).toBe('shed');
  });

  it('targetConcurrency の変更で drain が発火しキューのタスクが実行される', async () => {
    const limiter = new Limiter();
    limiter.updateDecision(makeDecision({ targetConcurrency: 1, shedProbability: 0 }));

    const blocker = deferred<void>();
    const p0 = limiter.submit(() => blocker.promise);
    const p1 = limiter.submit(() => Promise.resolve('queued'));

    // targetConcurrency を上げる → drain 発火
    limiter.updateDecision(makeDecision({ targetConcurrency: 10, shedProbability: 0 }));

    blocker.resolve();
    const [, r1] = await Promise.all([p0, p1]);
    expect(r1).toEqual({ status: 'executed', value: 'queued' });
  });
});
