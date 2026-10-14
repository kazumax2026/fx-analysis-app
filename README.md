# FX Compass — FX分析ダッシュボード

第1段階の日本語Webアプリです。iPad ProのSafariで縦・横向きに使用できます。

## 今回できること

- USD/JPY、EUR/JPY、GBP/JPYの切り替え
- 1時間足のローソク足（直近72本）
- 単純移動平均 MA 5 / MA 20、Wilder方式のRSI 14
- MACD（EMA 12 − EMA 26）とシグナル（EMA 9）、ヒストグラム
- 指標の条件を組み合わせた「買い・売り・様子見」判定

**すべて固定サンプルデータです。現在の為替レートではありません。** データ期間は2026年1月5日から120時間、UTC表示です。指標は120本から計算し、EMAは先頭終値を初期値にします。判定条件は画面内に説明しています。実際の注文機能、取引履歴、AI予測モデル、ライブデータ取得はありません。未来の確率は表示していません。

## iPadだけでアプリを確認する方法

現時点では公開していません。クラウド内の `localhost` はiPadのSafariから開けないため、GitHub PagesでWebサイトとして公開します。サーバー契約やAPIキーは不要です。

1. Codexの変更一覧を確認し、利用画面のGitHub連携機能から変更をPR（変更提案）として送信します。表示名は利用画面によって異なります。
2. SafariでGitHubの `kazumax2026/fx-analysis-app` を開きます。PRの「Files changed」で確認し、「Merge pull request」でmainへ取り込みます。
3. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。設定できない場合は管理者権限と、利用プランのPages対応を確認してください。初回の公開処理が失敗していても設定後に再実行できます。
4. **Actions → Publish dashboard to GitHub Pages → Run workflow** を選び、mainで実行します。チェックが緑になるまで待ちます。
5. **Settings → Pages** に表示される公開URLをSafariで開きます。標準設定なら `https://kazumax2026.github.io/fx-analysis-app/` です。公開完了前は開けません。
6. 通貨ボタンをタップし、価格と3つのチャートが変わることを確認します。Safariの共有ボタンから「ホーム画面に追加」もできます。

公開サイトは第三者にも閲覧可能になります。アプリに秘密情報は含めていません。公開処理はmainへの更新時にも実行されます。

## クラウド環境での実行

Node.js 24を使用します。外部パッケージのインストールは不要です。

```sh
cd /workspace/fx-analysis-app
npm test
npm start
```

サーバーはポート3000（`PORT`で変更可）で起動します。静的サイトなのでGitHub PagesではNode.jsサーバーは不要です。

## 次の開発段階

第2段階：取引履歴の入力・CSV取込と勝率・損益分析。
第3段階：実データを使ったモデル検証とAI予測。実装・評価が完了するまで確率は表示しません。
