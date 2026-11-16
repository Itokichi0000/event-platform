# 本番サーバーへの導入手順

VPS 1台に Docker Compose で Kamen を立てる手順です。例として Vultr の東京リージョン・Ubuntu 24.04 LTS を使いますが、
Docker が動く Ubuntu のサーバーならどこでも同じです。

ルーム（Marmot のチャット）は既定でオフです。この手順では立てません。

## 用意するもの

| もの           | 目安                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| VPS            | 日本のリージョン、メモリ 2GB 以上、Ubuntu 24.04 LTS。受付のたびにサーバーと通信するので国内がよい      |
| 独自ドメイン   | 例：`kamen.example.com`。HTTPS の証明書を自動で取るのに必要                                            |
| 主催者用の PC  | Nostr のブラウザ拡張（NIP-07。Alby、nos2x など）を入れた Chrome か Firefox。主催者画面のログインに使う |
| 受付用のスマホ | カメラのついたスマホ。アプリは不要（受付リンクをブラウザで開く）                                       |
| パスワード管理 | マスター鍵を保管する場所（パスワードマネージャーなど）                                                 |

Cloudflare などのプロキシ（オレンジの雲）は前に置かないでください。参加者全員の IP アドレスとアクセスがプロキシに見えてしまい、
「サーバーは IP を残さない」という約束が意味を失います。ドメインの購入先として使うだけなら問題ありません。

## 1. サーバーを作る

Vultr の場合：Deploy → Cloud Compute（Shared CPU）→ Location は Tokyo → Image は Ubuntu 24.04 LTS x64 →
メモリ 2GB のプランを選び、SSH 鍵を登録して作成します。作成後に表示される IPv4 アドレスを控えます。

## 2. ドメインをサーバーに向ける

ドメインの DNS 設定で、A レコードを追加します。

| 種類 | 名前                  | 値                       |
| ---- | --------------------- | ------------------------ |
| A    | `kamen`（または `@`） | サーバーの IPv4 アドレス |

反映されたかは手元の PC で確かめられます。サーバーの IP アドレスが返れば準備完了です（数分〜数時間かかることがあります）。

```bash
dig +short kamen.example.com
```

## 3. サーバーの初期設定

手元の PC から SSH でログインします。

```bash
ssh root@サーバーのIPアドレス
```

以下はサーバー上で実行します。まず更新と、必要なものを入れます。

```bash
apt update && apt upgrade -y
```

```bash
apt install -y docker.io docker-compose-v2 docker-buildx git ufw
```

外から受け付けるのは SSH と Web（80・443）だけにします。

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

ビルド中にメモリが足りなくならないよう、2GB のスワップを作ります。

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 4. Kamen を取得して設定する

```bash
git clone https://github.com/Itokichi0000/event-platform.git /opt/kamen
```

```bash
cd /opt/kamen && cp .env.example .env && chmod 600 .env
```

マスター鍵を作ります。表示された64文字を**必ずパスワードマネージャーなどに保管してください。**
なくすと、既存のイベントのチケットを一切検証できなくなります。

```bash
openssl rand -hex 32
```

`.env` を編集します。

```bash
nano .env
```

| 項目               | 書く内容                                                        |
| ------------------ | --------------------------------------------------------------- |
| `KAMEN_MASTER_KEY` | 上で作った64文字                                                |
| `KAMEN_DOMAIN`     | `kamen.example.com`（`https://` は付けない）                    |
| `PUBLIC_ORIGIN`    | `https://kamen.example.com`（主催者ログインの署名の確認に使う） |
| `POW_DIFFICULTY`   | そのままでよい（18）                                            |
| `ROOM_RELAYS`      | 空のまま（ルームはオフ）                                        |

## 5. 起動する

```bash
docker compose up -d --build
```

初回はビルドに数分かかります。終わったら状態を確かめます。

```bash
docker compose ps
```

```bash
curl -s https://kamen.example.com/api/health
```

`{"ok":true,"rooms":false}` と返れば動いています。HTTPS の証明書は Caddy が自動で取ります。
返らないときは、ドメインの向き先（手順2）とポート（手順3の ufw）を確かめ、ログを見ます。

```bash
docker compose logs --tail 50
```

ログに出るのはリクエストのパスとステータスだけです（IP アドレスと User-Agent は出ません）。

## 6. 動作確認（本番の前に一度）

スマホ2台と PC 1台で、作成から二重入場の拒否まで通します。

1. PC で `https://kamen.example.com/host` を開き、「Nostr拡張でログイン」→ 新しいイベントを作って公開する。
2. スマホA でイベントページを開き、チケットを取る（名前もメールも聞かれないこと）。
3. 管理画面で受付リンクを発行し、スマホB で開く。スマホA のチケットの QR を読み取って「入場OK」になる。
4. 同じ QR をもう一度読み取って、拒否される。
5. 管理画面のカウンターが「来場 1」になっている。

## 7. バックアップ

DB（イベント、鍵セットの暗号化された秘密鍵、使用済みチケットの記録）は Docker のボリュームにあります。
同梱のスクリプトで毎日バックアップし、3日分だけ残します。サーバーはイベント終了48時間後に秘密鍵などを消しますが、
バックアップにはその前の状態が残るため、長く残さないでください（docs/PRIVACY.md）。

```bash
/opt/kamen/deploy/backup.sh
```

毎日午前4時（UTC）に自動で実行するには：

```bash
(crontab -l 2>/dev/null; echo '0 4 * * * /opt/kamen/deploy/backup.sh >/dev/null 2>&1') | crontab -
```

バックアップは `~/kamen-backups/` にできます。マスター鍵は含まれないので、別に保管したものと組み合わせて使います。
戻すときは：

```bash
/opt/kamen/deploy/restore.sh ~/kamen-backups/kamen-YYYYMMDDTHHMMSSZ.sqlite
```

サーバーごと失ったときは、新しいサーバーで手順3〜5を同じマスター鍵で行い、バックアップを戻します。

## 8. 更新

更新の前にバックアップを取ってから、最新のコードで作り直します。DB の移行は起動時に自動で行われます。

```bash
cd /opt/kamen && deploy/backup.sh && git pull && docker compose up -d --build
```

## 本番当日のチェックリスト

- [ ] 前日までに手順6の動作確認を本番のドメインで済ませた
- [ ] 会場の電波（または Wi-Fi）で受付リンクが開けることを確かめた。不安なら、イベント作成時に「オフライン受付を使う」をオンにする
- [ ] 受付スマホを2台以上用意し、それぞれ受付リンクを開いておいた（1台が止まっても続けられる）
- [ ] 参加者向けに「チケットはブラウザに保存されます。ブラウザのデータを消したり機種変更する前に、チケット画面のバックアップを控えてください」と案内した
- [ ] 主催者は、参加者に連絡できない・名簿がないことを前提に告知を書いた（変更の連絡はイベントページのお知らせで行う）

## ルームを使うときは

`.env` の `ROOM_RELAYS` に使う公開リレーを書き、`rooms` プロファイルを付けて起動します。
ルームエージェントがルームの会話を読めること、参加者の IP アドレスがリレーに見えることを、参加者に伝えてください（docs/PRIVACY.md）。

```bash
docker compose --profile rooms up -d --build
```
