# PageWatch

自分専用のWebサイト更新監視ツールです。管理画面はブラウザで開きますが、監視処理はmacOSのバックグラウンドで動くため、ブラウザを閉じても監視を続けます。

## できること

- 管理画面から監視URLを追加・削除
- 5分〜6時間の確認間隔をサイトごとに設定
- ページ内の表示テキストと画像URLを比較
- スクリプト、スタイル、非表示要素、埋め込みフレームを比較から除外
- 更新履歴をSQLiteへローカル保存
- macOS通知センターへの通知
- SMTPメール通知
- 一時停止、手動確認、一括確認

監視URL・更新履歴・メール設定は `data/` に保存され、GitHubには含まれません。

## 固定URLで開く

公開後は、毎回ファイルをダウンロードせず次のURLから管理画面を開けます。

<https://t-shiokawa1.github.io/pagewatch/>

画面はGitHub Pagesから配信されますが、監視処理・URL・履歴・メール設定はこのMacの `server.py` と `data/` に残ります。利用時は `start.command` を起動してください。すでに監視エンジンが動いている場合は、固定URLだけが開きます。

## まず試す（ローカル画面）

`index.html`ではなく、`start.command` をダブルクリックします。PageWatchは監視データをローカル保存するため、HTMLファイル単体では動作しません。初回だけmacOSから実行確認が表示される場合があります。

ターミナルから起動する場合:

```bash
./start.command
```

公開前やオフライン時は、`http://127.0.0.1:8765` を直接開いても使えます。サーバーは自分のPCからだけアクセスできるアドレスに限定しています。

## ブラウザを閉じても監視する

```bash
chmod +x install-macos.sh
./install-macos.sh
```

macOSへログインするとPageWatchが自動起動します。PCがスリープまたは電源オフの間は確認できません。復帰後に監視を再開します。

## メール通知

画面右上の歯車から設定します。Gmailの場合はGoogleアカウントで発行したアプリパスワードが必要です。一般的なGmail設定は次のとおりです。

- SMTPホスト: `smtp.gmail.com`
- ポート: `587`
- SSL接続: オフ（STARTTLSを使用）
- ユーザー名・送信元: Gmailアドレス
- パスワード: アプリパスワード

認証情報は `data/settings.json` に所有者だけが読める権限で保存されます。

## 自動起動を解除する

```bash
chmod +x uninstall-macos.sh
./uninstall-macos.sh
```

自動起動だけを解除し、監視URL・履歴・設定は残します。

## GitHub Pagesへの公開

`main` ブランチへ変更をpushすると、`.github/workflows/pages.yml` が画面を自動ビルドしてGitHub Pagesへ反映します。通常は数分で固定URLの表示が更新されます。`.gitignore` により、次の個人データは公開されません。

- `data/` — URL、履歴、メール認証情報
- `node_modules/` — 開発用パッケージ
- `dist/` — ビルド成果物

公開画面が接続できるローカルAPIの公開元は `https://t-shiokawa1.github.io` だけに限定しています。リポジトリの所有者を変更する場合は、`server.py` の `DEFAULT_ALLOWED_ORIGINS` と固定URLを変更してください。

## 開発・テスト

```bash
npm install
npm run dev
```

Python APIは別のターミナルで起動します。

```bash
python3 server.py
```

テスト:

```bash
python3 -m unittest discover -s tests -v
npm run build
```

## 現在の比較方法

通常のHTMLレスポンスから、画面に表示される文章と画像URLを抽出して比較します。JavaScriptの実行後にだけ表示される内容や、同じURLのまま画像ファイルだけが差し替わるケースは初版では検知対象外です。
