<p align="center">
  <img src="desktop/src-tauri/icons/128x128.png" width="120px" alt="Sonora" />
</p>

<h1 align="center">Sonora</h1>

<p align="center">
  <a href="#english"><b>English</b></a> ｜ <a href="#日本語"><b>日本語</b></a>
</p>

---

## English

<p align="center">
  <b>A desktop music player for SoundCloud <i>and</i> YouTube.</b><br />
  One window, two services — switch with a single click.
</p>

### Screenshots

**YouTube mode** — imported playlists plus picks from the channels you keep:

![YouTube mode](docs/screenshots/youtube-home.png)

**SoundCloud mode** — full playlist pages with genres, stats and one-click playback:

![SoundCloud mode](docs/screenshots/soundcloud-playlist.png)

### Why Sonora?

Most players lock you into one service. Sonora treats **SoundCloud and YouTube as equals**: flip the brand in the titlebar and the whole app — home, search, pins, volume — follows the service. Your YouTube imports live next to your SoundCloud library, playable in the same queue, DJ decks and offline cache.

### Features

#### Two services, one player
- **One-click SoundCloud ⇄ YouTube switch** in the titlebar (Home, Search, sidebar pins and volume all follow the service)
- **Per-service volume** — SoundCloud and YouTube remember their own level
- **Unified queue** — mix SoundCloud and YouTube tracks in one playback session

#### Imports
- **YouTube playlists** — paste a link, get a local playlist (audio downloads on first play via yt-dlp)
- **Replace with the artist's channel** — re-uploads and lyric videos are swapped for the artist's own upload when found (optional, on by default)
- **Spotify playlists** — matched onto YouTube, preferring the artist's official channel
- **Yandex Music likes** — import your likes into SoundCloud

#### Playback & DJ
- Gapless-feel playback engine in Rust (rodio + symphonia), high-quality resampling
- **Two-deck DJ mode** — BPM + Sync, crossfade, auto-mix, DJ filter, flanger, waveform
- Playback speed & pitch controls, A–B loop, shuffle / repeat
- Hover-to-preview tracks without interrupting playback

#### Library & discovery
- Likes, playlists, followings, history, fresh drops from artists you follow
- Infinite SoundWave radio tuned to your taste (likes / skips / dislikes feedback)
- Discover catalogs (albums, artists, genres), search by text, vibe or lyrics
- **Lyrics** — synced karaoke + plain lyrics, manual search fallback (works for YouTube tracks too)
- Floating comments during playback

#### Offline & performance
- **Offline cache** with selectable format (m4a / mp3 / wav) and size limit; likes get a protected cache
- **Memory saver** — caps WebView heap/GPU caches; memory is auto-released while minimized
- Permanent on-disk image cache, virtualized lists everywhere

#### Integrations
- **Discord Rich Presence** with a per-service "Listen on SoundCloud / YouTube" button that opens the track
- System media keys + OS media popup (Windows SMTC / MPRIS), system tray + mini player
- Auto-updates via GitHub releases

### Dependencies

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 22+ | CI pins 22 |
| [pnpm](https://pnpm.io/) | 10+ | `corepack enable` also works |
| [Rust](https://rustup.rs/) | stable | via rustup |

Platform prerequisites (Tauri):

- **Windows** — Windows 10 (1809+) / 11, [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) ("Desktop development with C++"), WebView2 (preinstalled on Win10/11)
- **Linux** — webkit2gtk, rsvg, soup + build tools; see [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- **macOS** — Xcode Command Line Tools

No manual setup for media tools: **ffmpeg and yt-dlp are downloaded by the app itself** on first use (import / transcode flows).

### Setup & build

This repo is private — clone with an account that has access:

```bash
git clone https://github.com/b1skOwO/Sonora.git
cd Sonora/desktop
pnpm install --frozen-lockfile
```

Run in development mode (hot reload):

```bash
pnpm tauri dev
```

Production build (installer + portable bundle):

```bash
pnpm tauri build
```

Artifacts land in `desktop/src-tauri/target/release/bundle/`.

Checks (same as CI):

```bash
pnpm exec tsc --noEmit   # TypeScript
cargo check              # Rust (run in desktop/src-tauri)
cargo test --lib         # Rust tests
pnpm exec biome check src/  # lint
```

### Origin

Sonora is a fork of **[zxcloli666/SoundCloud-Desktop](https://github.com/zxcloli666/SoundCloud-Desktop)** — a native SoundCloud desktop client (Tauri 2 + React 19). All credit for the original client goes to its authors. Sonora extends it with YouTube playback, service switching, DJ mode, import flows and the changes listed above.

### Disclaimer — use at your own risk

- This is an **unofficial, community-built** client. It is **not affiliated with, endorsed by, or connected to SoundCloud, YouTube/Google, or Spotify**.
- Downloading, caching or converting audio may **violate the terms of service** of those platforms. Depending on your country, it may also infringe copyright law.
- Using third-party clients can lead to **account restrictions or bans** on those services.
- **You are solely responsible for how you use this software.** The authors accept no liability for any damage, data loss, account action or legal consequence arising from its use.
- All trademarks (SoundCloud, YouTube, Spotify, Discord) belong to their respective owners.

### License

MIT. See [LICENSE](LICENSE).

---

## 日本語

<p align="center">
  <b>SoundCloudもYouTubeも聴けるデスクトップ音楽プレイヤー。</b><br />
  タイトルバーのワンクリックで2つのサービスを切り替え。
</p>

### スクリーンショット

**YouTubeモード** — インポートしたプレイリスト＋よく聴くチャンネルからのおすすめ：

![YouTubeモード](docs/screenshots/youtube-home.png)

**SoundCloudモード** — ジャンル・統計付きのプレイリストページ、ワンクリック再生：

![SoundCloudモード](docs/screenshots/soundcloud-playlist.png)

### なぜSonoraか？

普通のプレイヤーは1つのサービスに縛られます。Sonoraは **SoundCloudとYouTubeを対等に扱います**：タイトルバーのブランドをクリックするだけで、ホーム・検索・ピン・音量まですべて追従。YouTubeのインポート曲もSoundCloudのライブラリと並び、同じキュー・DJデッキ・オフラインキャッシュで再生できます。

### 機能

#### 2サービス、1つのプレイヤー
- **SoundCloud ⇄ YouTubeをワンクリック切り替え**（ホーム・検索・サイドバーのピン・音量が連動）
- **サービス別音量** — SoundCloudとYouTubeで音量を個別に記憶
- **統合キュー** — SoundCloudとYouTubeの曲を混ぜて連続再生

#### インポート
- **YouTubeプレイリスト** — リンクを貼るだけでローカルプレイリスト化（音声は初回再生時にyt-dlpで取得）
- **アーティストのチャンネルに置き換え** — 転載・歌詞動画を、見つかれば本人の公式アップロードに差し替え（任意、デフォルトON）
- **Spotifyプレイリスト** — YouTube上でマッチング。本人チャンネルを優先
- **Yandex Musicのいいね** — SoundCloud側に取り込み

#### 再生・DJ
- Rust製再生エンジン（rodio + symphonia）、高品質リサンプリング
- **2デッキDJモード** — BPM＋Sync、クロスフェード、オートミックス、DJフィルター、フランジャー、波形表示
- 再生速度・ピッチ調整、A–Bループ、シャッフル／リピート
- 再生を邪魔しないホバープレビュー

#### ライブラリ・発見
- いいね、プレイリスト、フォロー、履歴、フォロー中アーティストの新譜
- 好みに合わせた無限ラジオSoundWave（いいね／スキップ／低評価で学習）
- Discoverカタログ（アルバム・アーティスト・ジャンル）、テキスト／雰囲気／歌詞で検索
- **歌詞** — 同期カラオケ＋プレーン歌詞、手動検索付き（YouTubeの曲にも対応）
- 再生中のフローティングコメント

#### オフライン・軽量化
- **オフラインキャッシュ**（形式選択可: m4a / mp3 / wav、容量上限あり）。いいねは保護キャッシュ
- **メモリ節約モード** — WebViewのヒープ／GPUキャッシュを制限。最小化中は自動でメモリ解放
- 画像の永続ディスクキャッシュ、全リスト仮想化

#### 連携
- **Discord Rich Presence** — サービス別の「Listen on SoundCloud / YouTube」ボタン付き（押すとその曲が開く）
- メディアキー＋OSメディアポップアップ（Windows SMTC / MPRIS）、トレイ＋ミニプレイヤー
- GitHubリリース経由の自動更新

### 依存関係

| ツール | バージョン | 備考 |
|---|---|---|
| [Node.js](https://nodejs.org/) | 22+ | CIは22固定 |
| [pnpm](https://pnpm.io/) | 10+ | `corepack enable`でも可 |
| [Rust](https://rustup.rs/) | stable | rustup経由 |

OS別の前提条件（Tauri）：

- **Windows** — Windows 10 (1809+) / 11、[Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（「C++によるデスクトップ開発」）、WebView2（Win10/11は標準搭載）
- **Linux** — webkit2gtk、rsvg、soup＋ビルドツール。詳細は[Tauri公式の前提条件](https://tauri.app/start/prerequisites/)参照
- **macOS** — Xcode Command Line Tools

メディアツールは手動導入不要：**ffmpegとyt-dlpは初回利用時にアプリが自動取得**します（インポート／変換機能用）。

### セットアップ＆ビルド

このリポジトリはプライベートです。アクセス権のあるアカウントでcloneしてください：

```bash
git clone https://github.com/b1skOwO/Sonora.git
cd Sonora/desktop
pnpm install --frozen-lockfile
```

開発モード（ホットリロード）で起動：

```bash
pnpm tauri dev
```

リリースビルド（インストーラー＋ポータブル）：

```bash
pnpm tauri build
```

成果物は `desktop/src-tauri/target/release/bundle/` に出ます。

チェック（CIと同内容）:

```bash
pnpm exec tsc --noEmit      # TypeScript
cargo check                 # Rust (desktop/src-tauri にて)
cargo test --lib            # Rustテスト
pnpm exec biome check src/  # lint
```

### フォーク元

Sonoraは **[zxcloli666/SoundCloud-Desktop](https://github.com/zxcloli666/SoundCloud-Desktop)**（Tauri 2 + React 19製のネイティブSoundCloudクライアント）のフォークです。オリジナルのクレジットはすべて原作者に帰属します。SonoraはここにYouTube再生、サービス切り替え、DJモード、各種インポート等を追加したものです。

### 免責 — 利用は自己責任で

- 本アプリは**非公式のコミュニティ製クライアント**です。**SoundCloud、YouTube/Google、Spotifyとは一切関係がなく、推奨・公認も受けていません**。
- 音声のダウンロード・キャッシュ・変換は、各プラットフォームの**利用規約に違反する可能性**があります。国によっては著作権法に触れる場合もあります。
- サードパーティ製クライアントの利用により、各サービスのアカウントが**制限・凍結される可能性**があります。
- **本ソフトの利用に関する一切の責任は利用者本人が負います**。損害・データ消失・アカウント措置・法的な問題について、作者は責任を負いません。
- 各商標（SoundCloud、YouTube、Spotify、Discord）はそれぞれの権利者に帰属します。

### ライセンス

MIT。詳細は [LICENSE](LICENSE) を参照。
