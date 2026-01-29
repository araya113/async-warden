// INVARIANT:
// - This layer MUST NOT make control decisions
// - Monitoring and smoothing only

import {
  monitorEventLoopDelay,
  type IntervalHistogram,
  performance,
  type EventLoopUtilization,
} from 'node:perf_hooks';

/**
 * Event Loop の状態を表すサンプル。
 * monitor 層の唯一の出力型。
 */
export type SystemSample = {
  ts: number;
  lag: {
    p50: number;
    p90: number;
    p99: number;
    mean: number;
    max: number;
  };
  elu: {
    value: number; // 0..1
  };
};

export type MonitorOptions = {
  /** Event Loop Delay の計測解像度（ms）。デフォルト: 20 */
  resolution?: number;
};

/**
 * Event Loop の状態を計測する Monitor クラス。
 * 判断は行わず、計測のみを担当する。
 */
export class Monitor {
  private readonly histogram: IntervalHistogram;
  private previousElu: EventLoopUtilization;
  private running = false;

  constructor(options: MonitorOptions = {}) {
    const resolution = options.resolution ?? 20;
    this.histogram = monitorEventLoopDelay({ resolution });
    this.previousElu = performance.eventLoopUtilization();
  }

  /**
   * 計測を開始する
   */
  start(): void {
    if (this.running) return;
    this.histogram.enable();
    this.running = true;
  }

  /**
   * 計測を停止する
   */
  stop(): void {
    if (!this.running) return;
    this.histogram.disable();
    this.running = false;
  }

  /**
   * 現在の SystemSample を取得し、ヒストグラムをリセットする。
   * 呼び出しごとに前回からの差分が計測される。
   */
  sample(): SystemSample {
    const currentElu = performance.eventLoopUtilization(this.previousElu);
    this.previousElu = performance.eventLoopUtilization();

    const sample: SystemSample = {
      ts: Date.now(),
      lag: {
        p50: this.nsToMs(this.histogram.percentile(50)),
        p90: this.nsToMs(this.histogram.percentile(90)),
        p99: this.nsToMs(this.histogram.percentile(99)),
        mean: this.nsToMs(this.histogram.mean),
        max: this.nsToMs(this.histogram.max),
      },
      elu: {
        value: currentElu.utilization,
      },
    };

    this.histogram.reset();
    return sample;
  }

  private nsToMs(ns: number): number {
    return ns / 1_000_000;
  }
}
