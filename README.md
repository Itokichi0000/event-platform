# Kamen（仮称）

身元を明かさずに物理イベントへ参加登録・入場できる、ビットコイナー向けのオープンソースWebアプリ（PWA）。

> **このサーバーのデータベースには、参加者を表すテーブルが存在しません。**
>
> 名前・メール・電話番号・npub の入力欄はありません。チケットはブラインド署名で発行されるため、
> サーバーも主催者も「誰に発行したチケットが入場に使われたか」を計算で結びつけることができません。
> サーバーが見るもの・保存するものは [docs/PRIVACY.md](docs/PRIVACY.md) にすべて列挙しています。

## しくみ（概要）

1. 参加者のブラウザが乱数の秘密値 `x` を作り、ブラインド化した `B_` だけをサーバーに送る。
2. サーバーは `B_` に署名して返す。`B_` は保存しない。
3. ブラウザがブラインドを外し、チケット `(x, C)` を端末内（IndexedDB）にだけ保存する。
4. 受付で QR を見せると、サーバーは署名を検証して `x` を使用済みにする。

手順2で見た `B_` と手順4で見た `x` を結びつける方法はありません。暗号は
[Cashu](https://github.com/cashubtc/nuts) の BDHKE（NUT-00）と DLEQ 証明（NUT-12）をそのまま使い、
公式テストベクターで検証しています。ただしチケットに金銭的価値はなく、サーバーは資金を一切預かりません。

詳しい設計は [docs/SPEC.md](docs/SPEC.md) を参照してください。

## 現在の状態

フェーズ2（運営機能）まで実装済み。無料・招待制・有料（Lightning）のイベントを作り、名前もメールも入れずに
チケットを受け取り、受付で入場できます。

| パッケージ           | 内容                                                                                        | 状態      |
| -------------------- | ------------------------------------------------------------------------------------------- | --------- |
| `packages/core`      | BDHKE、DLEQ、鍵セット、QR 用トークン符号化、PoW                                             | 実装済み  |
| `apps/server`        | Hono + SQLite の API（NIP-98、PoW・招待コード・NWC による発行、消し込み、返却、削除ジョブ） | 実装済み  |
| `apps/web`           | 参加者 PWA・主催者ダッシュボード・受付スキャナー（オフライン受付、日本語／英語）            | 実装済み  |
| `packages/messaging` | `MessagingAdapter` と Marmot 実装                                                           | フェーズ3 |

フェーズ2で入ったもの：有料チケット（主催者のウォレットへ NWC で直接入金）、招待コード、共同主催者、
オフライン受付、チケット返却、日本語／英語の切替、終了48時間後の秘密鍵・支払い記録の削除。
手動確認の手順は [docs/TESTING.md](docs/TESTING.md) を参照してください。

## 画面

| URL                | 画面                                                     |
| ------------------ | -------------------------------------------------------- |
| `/e/:id`           | イベントページ（「参加する」でチケット取得）             |
| `/tickets`         | マイチケット（オフラインでも開ける）                     |
| `/t/:id`           | チケットの QR、バックアップ                              |
| `/tickets/restore` | バックアップ文字列から復元                               |
| `/host`            | 主催者ダッシュボード（Nostr 拡張 NIP-07 でログイン）     |
| `/scan/:id#token`  | 受付スキャナー（ダッシュボードで発行したリンクから開く） |

## 開発

Node.js 22 以上と pnpm 10 が必要です。

```bash
pnpm install
```

API サーバーを起動します（別のターミナルで）。`KAMEN_MASTER_KEY` は鍵セットの秘密鍵を暗号化する鍵です。

```bash
cd apps/server && KAMEN_MASTER_KEY=$(openssl rand -hex 32) POW_DIFFICULTY=12 pnpm dev
```

Web を起動します。`/api` は `localhost:8787` に転送されます。

```bash
pnpm --filter @kamen/web dev
```

テスト・lint・型チェック・E2E：

```bash
pnpm test
```

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm e2e
```

## セルフホスト

Docker Compose で、Caddy（PWA の配信と `/api` の転送、自動 HTTPS）と API サーバーが起動します。
同梱の Caddy 設定はアクセスログを残さず、IP アドレスと User-Agent を API サーバーに渡しません。

```bash
cp .env.example .env
```

`.env` の `KAMEN_MASTER_KEY`（`openssl rand -hex 32` で生成）、`KAMEN_DOMAIN`、`PUBLIC_ORIGIN` を設定します。
マスター鍵をなくすと既存イベントのチケットを検証できなくなるため、DB とは別に保管してください。

```bash
docker compose up -d --build
```

## ライセンス

[MIT](LICENSE)（公開前に AGPLv3 と比較して最終決定する予定。docs/SPEC.md 10章）
