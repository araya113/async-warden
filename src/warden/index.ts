import { Monitor, type MonitorOptions, type SystemSample } from '../monitor/index.js';
import {
  Controller,
  type ControllerOptions,
  type ControlDecision,
} from '../control/index.js';
import {
  Limiter,
  type LimiterOptions,
  type LimiterResult,
  type TaskOptions,
} from '../limiter/index.js';

export type WardenOptions = {
  /** sample 取得の間隔（ms）。デフォルト: 1000 */
  intervalMs?: number;
  /** MonitorOptions または Monitor インスタンス */
  monitor?: MonitorOptions | Monitor;
  /** ControllerOptions または Controller インスタンス */
  controller?: ControllerOptions | Controller;
  /** LimiterOptions または Limiter インスタンス */
  limiter?: LimiterOptions | Limiter;
};

export class Warden {
  readonly monitor: Monitor;
  readonly controller: Controller;
  readonly limiter: Limiter;

  private readonly intervalMs: number;
  private timerId: ReturnType<typeof setInterval> | undefined;

  constructor(options: WardenOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1000;

    this.monitor =
      options.monitor instanceof Monitor
        ? options.monitor
        : new Monitor(options.monitor);

    this.controller =
      options.controller instanceof Controller
        ? options.controller
        : new Controller(options.controller);

    this.limiter =
      options.limiter instanceof Limiter
        ? options.limiter
        : new Limiter(options.limiter);
  }

  /** Monitor を start し、setInterval で制御ループを開始する */
  start(): void {
    this.monitor.start();

    this.timerId = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  /** clearInterval し、Monitor を stop する */
  stop(): void {
    if (this.timerId !== undefined) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
    this.monitor.stop();
  }

  /** limiter.submit への委譲 */
  async submit<T>(
    fn: () => Promise<T>,
    options?: TaskOptions,
  ): Promise<LimiterResult<T>> {
    return this.limiter.submit(fn, options);
  }

  /** 制御ループの 1 tick: sample → update → updateDecision */
  private tick(): void {
    const sample: SystemSample = this.monitor.sample();
    const decision: ControlDecision = this.controller.update(sample);
    this.limiter.updateDecision(decision);
  }
}
