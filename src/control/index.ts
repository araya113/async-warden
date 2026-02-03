// INVARIANT:
// - Decision making only
// - No direct execution control

import type { SystemSample } from '../monitor/index.js';

/**
 * control 層が下す制御判断の出力型。
 * limiter 層はこの型を入力として受け取り、実行制御に反映する。
 */
export type ControlDecision = {
  ts: number;
  pressure: {
    value: number; // 0..1
    components: {
      lag: number;
      elu: number;
    };
  };
  targetConcurrency: number;
  shedProbability: number;
  reasons: string[];
};

export type ControllerOptions = {
  lagThresholdMs?: number;
  eluThreshold?: number;
  lagWeight?: number;
  eluWeight?: number;
  ewmaAlpha?: number;
  maxConcurrency?: number;
  minConcurrency?: number;
  increaseStep?: number;
  decreaseFactor?: number;
};

function sigmoid(value: number, threshold: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (value - threshold)));
}

/**
 * SystemSample を受け取り、AIMD に基づく ControlDecision を返す。
 */
export class Controller {
  private readonly lagThresholdMs: number;
  private readonly eluThreshold: number;
  private readonly lagWeight: number;
  private readonly eluWeight: number;
  private readonly ewmaAlpha: number;
  private readonly maxConcurrency: number;
  private readonly minConcurrency: number;
  private readonly increaseStep: number;
  private readonly decreaseFactor: number;

  private smoothedPressure = 0;
  private previousSmoothedPressure = 0;
  private concurrency: number;

  constructor(options: ControllerOptions = {}) {
    this.lagThresholdMs = options.lagThresholdMs ?? 100;
    this.eluThreshold = options.eluThreshold ?? 0.8;
    this.lagWeight = options.lagWeight ?? 0.5;
    this.eluWeight = options.eluWeight ?? 0.5;
    this.ewmaAlpha = options.ewmaAlpha ?? 0.3;
    this.maxConcurrency = options.maxConcurrency ?? 100;
    this.minConcurrency = options.minConcurrency ?? 1;
    this.increaseStep = options.increaseStep ?? 1;
    this.decreaseFactor = options.decreaseFactor ?? 0.5;
    this.concurrency = this.maxConcurrency;
  }

  update(sample: SystemSample): ControlDecision {
    const normalizedLag = sigmoid(sample.lag.p99, this.lagThresholdMs, 0.05);
    const normalizedElu = sigmoid(sample.elu.value, this.eluThreshold, 10);

    const rawPressure =
      this.lagWeight * normalizedLag + this.eluWeight * normalizedElu;

    this.previousSmoothedPressure = this.smoothedPressure;
    this.smoothedPressure =
      this.ewmaAlpha * rawPressure +
      (1 - this.ewmaAlpha) * this.smoothedPressure;

    const reasons: string[] = [];

    if (this.smoothedPressure > this.previousSmoothedPressure) {
      this.concurrency = Math.floor(this.concurrency * this.decreaseFactor);
      reasons.push('pressure rising: multiplicative decrease');
    } else {
      this.concurrency += this.increaseStep;
      reasons.push('pressure falling: additive increase');
    }

    this.concurrency = Math.max(
      this.minConcurrency,
      Math.min(this.maxConcurrency, this.concurrency),
    );

    const shedThreshold = 0.5;
    const shedProbability =
      this.smoothedPressure <= shedThreshold
        ? 0
        : Math.min(1, (this.smoothedPressure - shedThreshold) / (1 - shedThreshold));

    if (normalizedLag > normalizedElu) {
      reasons.push('dominant signal: lag');
    } else if (normalizedElu > normalizedLag) {
      reasons.push('dominant signal: elu');
    }

    return {
      ts: sample.ts,
      pressure: {
        value: this.smoothedPressure,
        components: {
          lag: normalizedLag,
          elu: normalizedElu,
        },
      },
      targetConcurrency: this.concurrency,
      shedProbability,
      reasons,
    };
  }
}
