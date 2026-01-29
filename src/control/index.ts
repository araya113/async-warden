// INVARIANT:
// - Decision making only
// - No direct execution control

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
