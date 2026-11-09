# TKE Omicron Nu

Official chapter website for the Omicron Nu chapter of Tau Kappa Epsilon at
Florida Institute of Technology.

The site is a static HTML deployment hosted with GitHub Pages at
[tkeon.fit](https://tkeon.fit).

## Chapter dashboard

[tkeon.fit/Dashboard](https://tkeon.fit/Dashboard) shows how the chapter is doing
on nationals' Key Result Areas (KRAs) and what's on the calendar for the next 7 days.

- Members: `tkeon.fit/Dashboard`, a tabbed view that works on phones.
- Chapter-room TV: `tkeon.fit/Dashboard/?tv`, which rotates screens every 30 s.

The path is case-sensitive: `Dashboard`, not `dashboard`.

Data refreshes hourly. A GitHub Actions job reads the chapter Google Calendar
and logs in to the TKE national module, then writes to Supabase. The page reads
from Supabase. Until Supabase is set up, the page shows sample data.

| Path | What it is |
| --- | --- |
| `Dashboard/index.html` | The whole page (HTML/CSS/JS, no build step). `CONFIG` at the top of the script holds the Supabase URL and anon key. |
| `Dashboard/tke-logo-white.png` | **Add this:** the white TKE logo from [tke.org/logos](https://tke.org/logos). Until then the header shows a red "ΤΚΕ" box. |
| `supabase/schema.sql` | Tables and read-only policies. Run once in the Supabase SQL editor. |
| `supabase/pace.sql` | Sets the KRA year dates for the pace markers. |
| `sync/sync.mjs` | The hourly job: calendar + TKE KRA page → Supabase. |
| `sync/tke.config.json` | TKE login URL, KRA page URL and login field selectors. |
| `sync/check-rls.mjs` | Confirms the anon key can read but not write. |
| `sync/screenshots.mjs` | Screenshots every screen at TV size and 390 px, and checks the layout rules. |
| `.github/workflows/dashboard-sync.yml` | Runs the sync at minute 7 of every hour, or by hand. |

### Setup

1. **Supabase.** Create a project on the free tier. In the SQL editor, run
   `supabase/schema.sql`. Under Project Settings → API, copy the project URL and
   the **anon** (publishable) key into `CONFIG` in `Dashboard/index.html`. Then
   check that the key can't write:

   ```bash
   cd sync && npm ci
   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... node check-rls.mjs
   ```

   The anon key is fine to publish. The **service-role** key must only ever go
   in GitHub secrets. The page refuses to use it and shows a warning if it
   finds one in `CONFIG`.
2. **Calendar.** In Google Calendar, open the chapter calendar's settings and
   copy "Secret address in iCal format".
3. **TKE module.** Put the login page URL and the KRA page URL in
   `sync/tke.config.json`.
4. **GitHub secrets.** Under Settings → Secrets and variables → Actions, add
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GCAL_ICS_URL`, `TKE_USERNAME`
   and `TKE_PASSWORD`.
5. **First run.** Under Actions → Dashboard sync, click "Run workflow". If it
   fails, the log says why. A failed TKE step also uploads a
   `tke-debug-screenshot` artifact showing the page where the login stopped.

Setup can happen in any order. Until the Supabase secrets exist, each hourly
run skips itself with a notice instead of failing. After that, the calendar step
is skipped while `GCAL_ICS_URL` is unset, and the TKE step is skipped while both
URLs in `tke.config.json` still say `FILL_ME`. A half-finished TKE setup (one URL,
or URLs without the login secrets) still fails, so mistakes show up.
6. **Pace markers.** Fill in the KRA year dates in `supabase/pace.sql` and run
   it. The sync never touches `term_start`, `due_date` or `note`, so hand edits
   stick. A `note` shows on the KRA card (on the TV only when there's room).

If the TKE site asks for a CAPTCHA or a verification code, the sync stops and
the dashboard shows "The last sync failed". It never tries to get around either.
A rejected password fails once and isn't retried, so the account won't lock.

### Chapter-room TV

Open `https://tkeon.fit/Dashboard/?tv` full screen. On a Chrome box, use
`--kiosk`, and turn off sleep and the screensaver.

- `?rotate=45` sets seconds per screen. `?rotate=0` stops rotating.
- `?scene=kras`, `?scene=required` or `?scene=week` picks the starting screen.
- With a keyboard attached, ← and → switch screens and Space pauses.

The page re-reads the data every 5 minutes. If the network drops, it keeps
showing the last good data with a notice, retries with backoff, and catches up
as soon as Wi-Fi is back. Every 6 hours it reloads itself to pick up changes,
but only after checking the site is reachable. To avoid burn-in, the layout
moves a few pixels every hour. Each screen shrinks itself to fit 1080p without
scrolling.

### Notices on the page

| Notice | Meaning |
| --- | --- |
| Sample data | `CONFIG` is empty, or the URL has `?sample`. The numbers are nationals' KRA page from Oct 30, 2026; the events are made up. |
| This data is N hours old | No successful sync for over 3 hours. Check Actions. |
| The last sync failed | The latest run failed. The message says why; the page keeps the last good data. |
| Can't reach the database | The page couldn't load from Supabase. It shows what it last had and retries. |

### Working on it locally

```bash
cd sync
npm ci
npx playwright install chromium
npm test                    # calendar edge cases, KRA parsing, login against a mock TKE site
npm run shots               # screenshots + layout checks -> sync/.shots/
node sync.mjs --dry-run --ics=test/fixtures/chapter.ics   # parse without writing anything
```

Run `npm run shots` after every page change and look at the images. The TV
screens must fit 1920×1080 with nothing cut off, and the members' view must have
no horizontal scroll at 390 px.

### Things to know

- **This repo is public.** Anyone signed in to GitHub can read the Actions logs
  and download the debug screenshot for 3 days. The sync never logs secrets and
  redacts them from error messages, but the screenshot shows whatever TKE page
  the login stopped on.
- **Private calendar events** (marked Private in Google Calendar) are left off,
  because the members' view is public. Event descriptions are never copied.
- **Scheduled workflows in public repos** get switched off after 60 days with
  no commits. The workflow re-enables itself once a day to reset that clock. If
  the dashboard ever says the data is hours old, check that the workflow is
  still enabled under Actions.
- **Chapter-level data only.** Don't add member names, dues balances or GPAs:
  the members' view is public at that URL.
