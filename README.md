# Insta Unfollowers

Tired of thinking you have a lot of friends, buy you have none?

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Chrome extension that shows which Instagram accounts **you follow that don't follow you back** PLUS your "fans" (people who follow you that you don't follow back), to understand your own karma.

Everything runs **100% locally in your browser**, using the Instagram tab you are already logged in to. No external servers, no analytics, no credentials handled — ever.

## Features

- 🔍 **One-click scan** of your following and followers lists
- 📊 **Live progress** with real counts (the scan keeps running even if you close the popup)
- 🚫 **"Don't follow back" list** with profile picture, username, and a one-click **Unfollow** button — the row fades out and drops off the list once the unfollow succeeds
- 💜 **Fans tab** — people who follow you that you don't follow back, with a one-click **Remove** button (drops them as a follower; the row fades out)
- 📈 **Change tracking** — every scan is diffed against the previous one, so new unfollowers are badged **NEW** and a banner tells you how many you gained since last time
- ⏰ **Daily sync** (opt-in) — once a day while Chrome is open, rescan automatically and get a **system notification** summarising your totals and what changed
- 🍞 **Result toast/notification** after every scan: followers, following, don't-follow-back and fans counts, with the change since the last sync
- 🔎 **Search/filter** results by username or full name
- 🙈 **Ignore list** — hide accounts you never expect a follow-back from (celebrities, brands…)
- 📁 **CSV export** of any list (with spreadsheet formula-injection protection)
- 🔔 **Toolbar badge** with your unfollower count after each scan
- 🗑️ **One-click delete** of all locally stored data
- 🌙 Automatic dark mode
- 🐢 **Polite scanning**: randomized human-like delays between requests and exponential backoff when Instagram rate-limits

## Install (Developer mode)

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this project's folder (the one containing `manifest.json`).
5. Pin **Insta Unfollowers** to your toolbar.

To build a Web Store-ready zip instead: `./scripts/package.sh` (output in `dist/`).

## Usage

1. Open [instagram.com](https://www.instagram.com) and make sure you are logged in.
2. Click the extension icon and hit **Scan my account**.
3. Wait for the scan to finish — the popup can be closed; the scan continues inside the Instagram tab.
4. Browse the **Don't follow back** and **Fans** tabs, filter, ignore accounts, or export CSV.

Results are cached locally, so reopening the popup shows your last scan instantly. Hit **Rescan** any time.

### Unfollowing

Each row in the **Don't follow back** tab has an **Unfollow** button. Clicking it unfollows that one account through your own session (a single request, exactly like clicking Unfollow on the website); on success the row **fades out and disappears** from the list, and the account stays gone (even if you reopen the popup) until your next scan. There is intentionally **no bulk-unfollow**: mass actions are the fastest way to get action-blocked, so this tool keeps it one deliberate click at a time.

### Removing fans

Each row in the **Fans** tab has a **Remove** button. Clicking it removes that account as a follower (they follow you; you don't follow them back) — the same action as **Remove** on Instagram's own followers list. The row fades out the same way Unfollow does, and stays gone until your next scan. Same rule: one click, one request, no bulk remove.

### Daily sync & notifications (opt-in)

Open **⚙️ Settings** to enable:

- **Daily sync** — once per day, while Chrome is running, the extension rescans automatically. It reuses an open Instagram tab if you have one, otherwise it briefly opens one in the background. **Off by default.**
- **Notify results** — after a background sync, show a desktop notification with your totals and what changed (e.g. new unfollowers) since the last sync. On by default, but only ever fires when a sync runs in the background.

You can also **delete all stored data** from the settings panel.

## How it works

```
popup (UI)  ──messages──▶  content script (runs on instagram.com)
   ▲                          │  paginated GET requests to Instagram's own
   │                          │  web API, using your existing session cookies
   └──── chrome.storage.local ◀┘  (results stored locally, on your machine)
```

- The content script reads your own user id from the `ds_user_id` cookie and pages through Instagram's private web API (`/api/v1/friendships/<id>/following` and `/followers`) — the same endpoints the Instagram web app itself uses when you open your followers dialog.
- Requests are throttled with randomized delays (~1–2s per page of 100 accounts) and back off exponentially if Instagram responds with HTTP 429.
- The two lists are compared by user id; results land in `chrome.storage.local` only.
- Each scan is diffed against the previous one for the same account, and a rolling history of per-scan snapshots is kept locally for change tracking.
- The **Unfollow** and **Remove** buttons call `friendships/destroy` and `friendships/remove_follower` for a single account per click — never in bulk.
- **Daily sync** is driven by a `chrome.alarms` timer in the service worker; it only runs if you turned it on, at most once per ~20h, and posts results via `chrome.notifications`.

## Privacy

- **No data ever leaves your browser.** The only network requests made are to `www.instagram.com`, from your own session.
- The extension never reads your password or session token; it only checks the non-sensitive `ds_user_id` / `csrftoken` cookies that instagram.com exposes to every script on its own page.
- Permissions used: `storage`/`unlimitedStorage` (cache results locally), `scripting` (inject the scanner into your Instagram tab if needed), `alarms` (schedule the optional daily sync), `notifications` (show the opt-in result notification), and host access to `https://www.instagram.com/*` only.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Open Instagram to start" | Open instagram.com in a tab and log in, then reopen the popup. |
| "You don't appear to be logged in" | Log in to Instagram in that tab. |
| "Could not reach your Instagram tab" | Reload the instagram.com tab (it may have been asleep), then retry. |
| "Instagram is rate-limiting requests" | Wait 15–30 minutes and rescan. The extension already retries with backoff. |
| Scan is slow | Normal for large accounts: ~100 accounts per request, 1–2s apart, to stay under Instagram's radar. |
| Broken avatars in old results | Instagram image URLs expire; rescan to refresh them. |

## Development

```
insta-unfollowers/
├── manifest.json               # Manifest V3
├── icons/                      # generated by scripts/generate-icons.py
├── src/
│   ├── lib/
│   │   ├── ig-api.js           # Instagram API client (pagination, retry/backoff) — pure ESM
│   │   └── compare.js          # list comparison, filtering, CSV — pure ESM
│   ├── content/content.js      # scan runner, lives in the instagram.com tab
│   ├── popup/                  # UI (popup.html / popup.css / popup.js)
│   └── background/service-worker.js  # toolbar badge only
├── tests/                      # Node unit tests (zero dependencies)
└── scripts/                    # icon generator + zip packager
```

The `src/lib/` modules are dependency-injected pure ES modules, so the entire pagination/retry/compare logic is unit-tested in Node:

```bash
npm test          # runs node --test tests/  (requires Node >= 20)
```

Regenerate icons with `npm run icons`.

## Ideas for future features

Common in similar tools, and safe to add **without violating Instagram's policies** (no bulk automation, no scraping of accounts that aren't yours, no fake engagement):

- **Mutual / one-way indicators everywhere** — tag each row as "you follow", "follows you", or "mutual".
- **Watchlist** — star specific accounts and get alerted the moment they unfollow you (uses the diff you already store).
- **History charts** — you already persist per-scan snapshots (`histories` in storage); render a small followers/following/unfollowers trend line over time.
- **"Recently lost followers"** — surface who unfollowed you between the last two scans (the diff already computes this).
- **Non-followers you interact with** — combine the don't-follow-back list with accounts you've recently visited, to prioritise who to unfollow.
- **Ghost/inactive follower estimate** — flag followers with no profile picture or that are private+zero-posts (read-only heuristic on data you already fetch).
- **Pending sent requests** — list follow requests you sent that are still unanswered (Instagram exposes this for your own account).
- **Close-friends & verified filters** — quick toggles to filter results by verified / private.
- **Snooze / re-check reminders** — instead of daily, let the user pick weekly/monthly sync cadence.
- **Export to JSON** and **import** to diff across devices manually.
- **Undo buffer** — a session list of accounts you unfollowed, with a one-tap "re-follow all from this session".

Deliberately **out of scope** (these break Instagram's Terms and risk bans): bulk/auto unfollow, follow, or remove-follower, auto-DM, auto-like/comment, follow/unfollow scheduling loops, buying/farming followers, or scanning accounts other than your own.

## Disclaimer

This is an unofficial tool, not affiliated with or endorsed by Instagram/Meta. It only reads data your own account can already see, at a human-like pace — but automated access of any kind is against Instagram's Terms of Use, so **use it at your own risk** (a very aggressive rescan loop could get your account temporarily action-blocked). Don't run scans more often than you need to.

## License

[MIT](LICENSE)
