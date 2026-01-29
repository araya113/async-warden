# async-warden

> **⚠️ このプロジェクトは開発中です。API は不安定であり、破壊的変更が入る可能性があります。**

Node.js の Event Loop を監視し、過負荷状態に陥る前にサーバを予防的に守る TypeScript 製ライブラリです。

## 概要

- Event Loop Lag / ELU を組み合わせて負荷を評価
- 閾値の ON/OFF ではなく、段階的・適応的に制御
- 制御理由を追跡可能（説明可能な shedding）

## アーキテクチャ

| レイヤー | 責務 |
|---------|------|
| **monitor** | メトリクス計測・平滑化 |
| **control** | 状態評価・制御判断 |
| **limiter** | 実行制御（キューイング・shedding） |

## セットアップ

```bash
npm install
npm run build
```

## 要件

- Node.js 18+
- TypeScript / ESM
