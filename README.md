# Readine Sync — Obsidian Plugin

One-way sync of [Readine](https://readine.app) articles into your Obsidian vault. Supports manual and auto-sync, network gating, and local-edit protection — your edits to synced notes are never overwritten silently.

## Features

- **One-way sync** — articles flow from Readine to vault; local edits are never overwritten
- **Two output formats** — Markdown (default) or HTML
- **Customizable path template** — organize synced files with tokens: `{feedName}`, `{feedId}`, `{yyyy}`, `{mm}`, `{dd}`, `{title}`, `{articleId}`
- **Configurable article template** — control YAML frontmatter and note layout with `{{title}}`, `{{date}}`, `{{url}}`, `{{tags}}`, `{{notes}}`, `{{text}}`
- **Auto-sync** — pull new articles on a schedule (off, 5, 15, 30 min, 1–24 hours)
- **Delete policy** — keep or remove server-deleted articles (with local-edit protection)
- **Network gating** — restrict sync to Wi-Fi only, Wi-Fi + cellular, or all networks
- **Attachment** — fetch images and files alongside articles
- **Cache cleanup** — auto-remove articles older than N days (off, 7, 30, 90, 365)
- **Favorites / notes protection** — skip deleting favorited articles or articles with notes
- **Sync progress bar** — live progress during sync operations
- **Crash recovery** — survive unexpected shutdowns mid-sync
- **10-language UI** — English, Русский, Deutsch, Français, 日本語, Português, Español, 中文, Italiano, 한국어

## Settings

**Output format** — `markdown` (default) or `html`. Markdown saves articles as `.md` with YAML frontmatter and extracted body text; HTML saves raw `.html` as-is. Switching format auto-updates the extension in **Path template**. Also controls visibility of **Article template**.

**Path template** — vault path with tokens: `{feedName}`, `{feedId}`, `{yyyy}`, `{mm}`, `{dd}`, `{title}`, `{articleId}`. Default: `Readine/{feedName}/{yyyy}-{mm}/{title}.md`.

**Article template** — content layout for markdown notes. Only visible when **Output format** = `markdown`. Placeholders: `{{title}}`, `{{date}}`, `{{url}}`, `{{tags}}`, `{{feedName}}`, `{{feedId}}`, `{{id}}`, `{{notes}}`, `{{text}}`.

**Download only** — when enabled (`true`, default), only articles starred in Readine are synced.

**Delete policy** — what happens when an article is removed server-side: `keep` (default, leave file in vault) or `delete` (remove file). Even with `delete`, a file is not removed if you've edited it locally or if it's protected by **Skip favorited** / **Skip with notes**.

**Auto-sync interval** — pull frequency: `off`, `5`, `15`, `30`, `60`, `240`, `480`, `1440` minutes. Default: `5`. Each tick is gated by **Network for articles** and only starts after the setup wizard is completed.

**Network for articles** — which networks are allowed for downloading article bodies: `always` (desktop default), `Wi-Fi+cellular`, `Wi-Fi-only` (mobile default), `off`. `off` blocks all sync.

**Remove old articles** — auto-remove articles older than N days: `off` (default), `7`, `30`, `90`, `365`. Articles protected by **Skip favorited** or **Skip with notes** survive cleanup regardless of age.

**Skip favorited** — when `true` (default), favorited articles are never deleted by **Delete policy** or **Remove old articles**.

**Skip with notes** — when `true` (default), articles with notes are never deleted by **Delete policy** or **Remove old articles**.

**Interface language** — UI language: `en`, `ru`, `de`, `fr`, `ja`, `pt`, `es`, `zh`, `it`, `ko`. Auto-detected from Obsidian on first launch.

**Notifications badge** — show unread count on the ribbon icon. Default: `true`.



## Installation

### Community Plugin (recommended)

1. Open Obsidian Settings → Community plugins
2. Click **Browse** and search for "Readine Sync"
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/USER/REPO/releases/latest)
2. Copy them into `{vault}/.obsidian/plugins/readine-sync/`
3. Reload Obsidian, then enable the plugin in Settings → Community plugins

## Setup

1. Open the **Readine app** → Settings → Obsidian → generate a code
2. In Obsidian, go to **Settings → Readine Sync** → paste the code → click **Connect**
3. Configure your preferences: output format, path template, auto-sync interval, network gating
4. Click **Sync now** 

## License

MIT — see [LICENSE](LICENSE).


# About Readine

> Readine is a subscription reader app that puts Telegram, YouTube, Substack, Boosty, Fanbox, and RSS into one place — without algorithms, recommendations, or ads.

Readine is **not just an RSS reader**. It works equally well as a Feedly/Inoreader alternative (full OPML import), a Telegram-channel reader without opening Telegram, a YouTube-subscription tracker without algorithmic recommendations, a Substack newsletter reader, and a way to follow Boosty/Fanbox creators (including paid tiers) in one app. **Readine is not a Pocket/Instapaper replacement** — it tracks sources you subscribe to, not individual saved articles.

Available on iOS, Android, macOS, Windows, Ubuntu/Debian (apt), and the web. Source state, read state, notes, and tags sync across all your devices.

Pricing: free plan with 3 feeds, no time limit, no ads. Three-week trial of 10 feeds. Paid subscription is **modular** — you only pay for the modules you use (rules, keyword notifications, Obsidian/Dropbox export, faster refresh). Exact prices are shown inside the app.

Privacy: no ads ever (free or paid), no data sales, no ad networks, no cookies, no recommendations, no algorithmic feed. Articles appear in publication order. Account registration is required (Readine is SaaS, not self-hosted).

[Home page](https://readine.app/en/): product overview, sources, features, pricing model, privacy stance

[details.txt](https://readine.app/llms-full.txt): full text of core pages and FAQ in one document