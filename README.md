# LINE → Slack → Dots 中継

個人のLINE公式アカウント「Dots」（`@638fnwlr`）から、Slackの `#チャンネル-サンプル` にメンションを送り、Dotsのスレッド返信をLINEへ返します。登録したLINEユーザー1人からのテキストだけを受け付けます。

## 公開先

- Worker: https://line-dots-bridge.line-dots-bridge.workers.dev
- ヘルスチェック: `/health`
- LINE Webhook: `/line`
- Slack Events API: `/slack`

Cloudflare WorkersとSQLite Durable Objectで動作します。PCを起動しておく必要はありません。モデルのAPIキーは使用せず、Slackに接続したDotsへ依頼します。CloudflareとLINEそれぞれの契約プラン・利用上限が適用されます。

## 設定済みの外部サービス

LINEチャネル `2012039161` のWebhookを有効にし、定型の応答メッセージを無効にしています。

Slackアプリ `line-dots-bridge`（`A0C9E19LY83`）は、User OAuthの `chat:write` と `groups:history` を使用します。Socket Modeを無効にし、`message.groups` の購読先を `/slack` に設定しています。権限自体は参加中のプライベートチャンネルに及びますが、中継コードは設定したチャンネル・DotsのユーザーID・スレッドだけを対象にします。

User OAuth Tokenによる投稿には、本人のユーザーIDと中継アプリのBot IDが付くことを確認しています。Dotsがこの投稿に返信するかは、Webhookの接続成功とは別に確認が必要です。

## ローカルでの検証と公開

Node.js 24以降（組み込み `node:sqlite` を使うテストが動くバージョン）で実行します。

```sh
npm ci --ignore-scripts
npm test
npm run check
npx wrangler deploy --dry-run
npx wrangler login
npm run deploy
```

秘密情報はリポジトリ外の `../../work/line-dots.env` に保存しています。チャットやGitには値を貼らないでください。Cloudflareでは以下をWorker Secretsへ登録済みです。

- `SLACK_USER_TOKEN`
- `SLACK_SIGNING_SECRET`
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_ALLOWED_USER_ID`

秘密情報を更新した場合は、このディレクトリから次を実行します。

```sh
npx wrangler secret bulk ../../work/line-dots.env
```

チャンネルやDotsの宛先は `wrangler.jsonc` のvarsで指定します。

## 配信と障害の確認

LINEとSlackの署名を検証し、受信イベントを永続キューに保存してから直ちに応答します。実際の配信はDurable ObjectのAlarmで処理します。同じイベントIDは重複送信しません。LINEの続きの発言は、初回に作ったSlackスレッドへ送信します。

```sh
npx wrangler tail --format pretty
```

配信完了は `delivery_done`、失敗は `delivery_failed` とジョブID・原因を記録します。HTTP 200のWebhook応答だけでは外部への配信完了を意味しません。メッセージ本文とトークンをアプリログに出力しません。

外部APIのタイムアウトなど、送信済みか判断できない失敗は自動再送しません。キューの `failed` / `sending` 状態を残します。Slackの実際の投稿を確認したうえで再送の要否を判断してください。再起動後もスレッドとキューは保持されます。

## 対応範囲

- LINEの個人トークからのテキスト送信
- Dotsによる、対応するSlackスレッド内の新規テキスト返信
- LINEの文字数上限を超える回答の分割

画像・ファイル・音声・グループトーク、Slack上の既存返信の編集反映は対象外です。メッセージと配信状態はDurable Objectに保存されます。
