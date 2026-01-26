# ARCHITECTURE

このファイルは **async-warden の設計上の不変条件** です。

* 設計思想に反する実装はしないでください。
* 人間だけでなく、AI支援ツール（Cursor / Claude Code）にも読まれることを前提にしています。

---

## High-level overview

async-warden は、次の 3 つの層に分離されています。

```
┌──────────┐
│ monitor  │  計測
└────┬─────┘
     │ SystemSample
┌────▼─────┐
│ control  │  判断
└────┬─────┘
     │ ControlDecision
┌────▼─────┐
│ limiter  │  防御
└──────────┘
```

各層は **一方向の依存関係** を持ちます。

* monitor → control → limiter
* 逆方向の依存は禁止

---

## monitor layer

### Responsibility

monitor 層の責務は **「事実を正確に計測すること」** です。

* 状態を観測する
* 値を平滑化・集計する
* 判断や制御は行わない

monitor は **意思決定を持ちません**。

### Output

monitor は `SystemSample` を出力します。

```ts
type SystemSample = {
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
```

---

## control layer

### Responsibility

control 層は **「どう制御すべきかを判断する」** 層です。

* `SystemSample` を入力として受け取る
* 状態を評価する（Lag + ELU を組み合わせる）
* 連続的・適応的な制御判断を出力する

control は **実際の処理を直接制御しません**。

### Output

control は `ControlDecision` を出力します。

```ts
type ControlDecision = {
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
```

---

## limiter layer

### Responsibility

limiter 層は **「判断を実際の挙動に反映する」** 層です。

* 同時実行数制御（adaptive concurrency）
* キューイング
* 優先度制御
* shedding（拒否）

limiter 自身は **制御方針を決めません**。

---

## Explainability

async-warden は **説明可能性** を最重要視します。

* なぜ制御が入ったのか
* なぜ同時実行数が下がったのか
* なぜタスクが落とされたのか

これらが説明できない挙動は設計違反です。

---

## Forbidden patterns

以下は明確な設計違反です。

* monitor 内で制御判断を行う
* limiter 内で Lag / ELU を直接参照する
* 固定値のハード閾値制御
* 理由を説明できない拒否ロジック
* 責務をまたいだ密結合

---

## Related docs

* `docs/architecture.md` : 詳細版
* `docs/decision-model.md` : Lag + ELU → pressure → 制御の意思決定
* `docs/limiter-behavior.md` : limiter の挙動（queue / priority / shedding）
