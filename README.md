<p align="center">
  <img src="desktop/src-tauri/icons/128x128.png" width="120px" alt="Sonora" />
</p>

<h1 align="center">Sonora</h1>

<p align="center">
  <b>A desktop music player for SoundCloud <i>and</i> YouTube.</b><br />
  One window, two services — switch with a single click.<br />
  <a href="README.ja.md">日本語版はこちら</a>
</p>

---

## Screenshots

**YouTube mode** — imported playlists plus picks from the channels you keep:

![YouTube mode](docs/screenshots/youtube-home.png)

**SoundCloud mode** — full playlist pages with genres, stats and one-click playback:

![SoundCloud mode](docs/screenshots/soundcloud-playlist.png)

---

## Why Sonora?

Most players lock you into one service. Sonora treats **SoundCloud and YouTube as equals**: flip the brand in the titlebar and the whole app — home, search, pins, volume — follows the service. Your YouTube imports live next to your SoundCloud library, playable in the same queue, DJ decks and offline cache.

---

## Features

### Two services, one player
- **One-click SoundCloud ⇄ YouTube switch** in the titlebar (Home, Search, sidebar pins and volume all follow the service)
- **Per-service volume** — SoundCloud and YouTube remember their own level
- **Unified queue** — mix SoundCloud and YouTube tracks in one playback session

### Imports
- **YouTube playlists** — paste a link, get a local playlist (audio downloads on first play via yt-dlp)
- **Replace with the artist's channel** — re-uploads and lyric videos are swapped for the artist's own upload when found (optional, on by default)
- **Spotify playlists** — matched onto YouTube, preferring the artist's official channel
- **Yandex Music likes** — import your likes into SoundCloud

### Playback & DJ
- Gapless-feel playback engine in Rust (rodio + symphonia), high-quality resampling
- **Two-deck DJ mode** — BPM + Sync, crossfade, auto-mix, DJ filter, flanger, waveform
- Playback speed & pitch controls, A–B loop, shuffle / repeat
- Hover-to-preview tracks without interrupting playback

### Library & discovery
- Likes, playlists, followings, history, fresh drops from artists you follow
- Infinite SoundWave radio tuned to your taste (likes / skips / dislikes feedback)
- Discover catalogs (albums, artists, genres), search by text, vibe or lyrics
- **Lyrics** — synced karaoke + plain lyrics, manual search fallback (works for YouTube tracks too)
- Floating comments during playback

### Offline & performance
- **Offline cache** with selectable format (m4a / mp3 / wav) and size limit; likes get a protected cache
- **Memory saver** — caps WebView heap/GPU caches; memory is auto-released while minimized
- Light / Balanced / Beauty visual modes for weak to strong hardware
- Permanent on-disk image cache, virtualized lists everywhere

### Integrations
- **Discord Rich Presence** with a per-service "Listen on SoundCloud / YouTube" button that opens the track
- System media keys + OS media popup (Windows SMTC / MPRIS), system tray + mini player
- Auto-updates via GitHub releases

---

## Build from source

```bash
cd desktop
pnpm install
pnpm tauri build
```

Requirements: **Node.js** 22+, **pnpm** 10+, **Rust** stable. Artifacts land in `desktop/src-tauri/target/release/bundle/`.

Checks:

```bash
pnpm exec tsc --noEmit   # TypeScript
cargo check              # Rust (in desktop/src-tauri)
pnpm exec biome check src/  # lint
```

---

## Origin

Sonora is a fork of **[zxcloli666/SoundCloud-Desktop](https://github.com/zxcloli666/SoundCloud-Desktop)** — a native SoundCloud desktop client (Tauri 2 + React 19). All credit for the original client goes to its authors. Sonora extends it with YouTube playback, service switching, DJ mode, import flows and the changes listed above.

---

## Disclaimer — use at your own risk

- This is an **unofficial, community-built** client. It is **not affiliated with, endorsed by, or connected to SoundCloud, YouTube/Google, or Spotify**.
- Downloading, caching or converting audio may **violate the terms of service** of those platforms. Depending on your country, it may also infringe copyright law.
- Using third-party clients can lead to **account restrictions or bans** on those services.
- **You are solely responsible for how you use this software.** The authors accept no liability for any damage, data loss, account action or legal consequence arising from its use.
- All trademarks (SoundCloud, YouTube, Spotify, Discord) belong to their respective owners.

---

## License

MIT. See [LICENSE](LICENSE).
