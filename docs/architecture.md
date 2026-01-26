# Architecture

このドキュメントは **async-warden の内部設計思想と構造** を説明します。

ここに書かれている内容は単なる実装メモではなく、
**プロジェクトの設計上の不変条件** を定義するものです。

---

## Architectural goals

async-warden のアーキテクチャは、以下を満たすことを目的とします。

- Event Loop の状態を正しく把握できること
- 制御判断の理由を説明できること
- 過剰遮断やフラッピングを起こさないこと
- 実運用で安定して動作すること
- 読めば「なぜそうしているか」が理解できること

「速く書ける」「短く書ける」ことよりも  
**理解可能性・保守性・拡張性** を優先します。

---

## High-level overview

async-warden は、次の 3 つの層に明確に分離されています。

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

- monitor → control → limiter
- 逆方向の依存は禁止されます

---

## monitor layer

### Responsibility

monitor 層の責務は **「事実を正確に計測すること」** です。

- 状態を観測する
- 値を平滑化・集計する
- 判断や制御は行わない

monitor は **意思決定を持ちません**。

---

### Inputs / Outputs

**Input**
- Node.js runtime（Event Loop）

**Output**
- `SystemSample`

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

### Key design points

- Node.js 標準 API（`perf_hooks`）を使用する
- Lag は平均値ではなく **テイル（p90 / p99）** を重視
- ELU は **delta ベース** で扱う
- 瞬間値のノイズを避けるため、EWMA 等の平滑化は許容される
- ただし「この値なら制限する」といった意味付けは禁止

---

## control layer

### Responsibility

control 層は **「どう制御すべきかを判断する」** 層です。

- monitor の結果を入力として受け取る
- 状態を評価する
- 制御量を決定する

control は **実際の処理を直接制御しません**。

---

### Inputs / Outputs

**Input**
- `SystemSample`

**Output**
- `ControlDecision`

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

### Pressure model

control 層では、Lag と ELU を **単一の圧力（pressure）** に統合します。

- Lag: 現在すでに起きている遅延
- ELU: これから起きうる混雑の兆候

pressure は **連続値（0..1）** として扱われます。

> pressure は「遮断するか否か」ではなく
> **制御の強さを決めるための内部状態** です。

---

### Adaptive control

control 層は **二値的な制御を行いません**。

- 悪化時: 素早く制限を強める
- 回復時: ゆっくり制限を緩める

これにより以下を防ぎます。

- フラッピング
- 過剰遮断
- 不安定なスループット

---

### Invariants

control 層では次を守る必要があります。

- 固定閾値による ON / OFF 制御を避ける
- 出力は連続的に変化すること
- 判断理由を `reasons` として表現できること

---

## limiter layer

### Responsibility

limiter 層は **「判断を実際の挙動に反映する」** 層です。

- 同時実行数制御
- キューイング
- 優先度制御
- shedding（拒否）

limiter 自身は **制御方針を決めません**。

---

### Inputs

- `ControlDecision`
- 実行要求（task）
  - priority
  - deadline（任意）

---

### Behavior

limiter は次を考慮して挙動を決定します。

- 現在の `targetConcurrency`
- キュー長
- タスクの優先度
- shedding 確率

拒否が発生する場合は、  
**なぜ拒否されたのかを説明できなければなりません。**

---

## Explainability

async-warden 全体を通じた重要な設計目標は  
**「説明可能性」** です。

- なぜ制御が入ったのか
- なぜ同時実行数が下がったのか
- なぜこのタスクが落とされたのか

これらは、

- pressure
- decision
- runtime state

を組み合わせて説明可能である必要があります。

---

## Forbidden patterns

以下は設計違反と見なされます。

- monitor 内で制御判断を行う
- limiter 内で Lag / ELU を直接参照する
- 固定値のハードな閾値制御
- 理由を説明できない拒否ロジック
- 責務をまたいだ密結合

---

## For contributors and AI tools

このドキュメントは
**人間と AI 支援ツールの両方に向けた設計ガイド** です。

変更を加える場合は、必ず次を確認してください。

- どの層の責務か
- 他層に漏れていないか
- なぜこの設計が必要か説明できるか

設計を壊さずに機能を追加することが
このプロジェクトの最重要課題です。

---

## Summary

- async-warden は 3 層構造を厳格に守る
- Lag と ELU を組み合わせた予防的制御を行う
- 連続的・適応的な制御を採用する
- 説明できない挙動は許容しない

この設計思想は、  
実装が進んでも変わりません。