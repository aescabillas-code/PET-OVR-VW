# PAT (PET Automation Tool): Streamlit + MongoDB Atlas (single Python file)

```
Browser ── Streamlit page ── component (web/pet_station.html + web/shim.js)
                │  requests ride on the Streamlit connection (about once a second, instantly on a save)
                ▼
        streamlit_app.py  ──►  MongoDB Atlas (database "pet_station")
```

* `streamlit_app.py` holds everything on the Python side: Atlas connection, storage, sync protocol and the page.
  There is no separate API server and the browser never talks to MongoDB, so it works on Streamlit Community Cloud.
* The HTML app is PAT (PET Automation Tool). `web/shim.js` gives it the storage it expects, backed by MongoDB: cases, checklists and
  documentation, orders, revisits, activity history, announcements and acknowledgements, mentions/notices, shift
  schedule, alert settings, required checklist items, profile password hashes (`config/profileHashes`) and the shared alert audio.
* Live updates: every reply carries a change counter per collection; a screen refetches only what changed.
* Not saved on purpose: simulation data and per-device preferences (signed-in profile, volume, device-only audio).

## Run

```bash
pip install -r requirements.txt
cp .env.example .env          # set MONGODB_PASSWORD to your Atlas database user's password
streamlit run streamlit_app.py
```

In Atlas, open **Network Access** and allow your IP address (use `0.0.0.0/0` while testing; on Streamlit Community Cloud
you need that, since its IP changes).

The sidebar shows the storage status. The app itself stays quiet when saving works; a small badge at the bottom-left appears only if MongoDB is not connected or a storage error occurs.
If MongoDB drops out or is briefly unreachable, the app keeps working and reconnects by itself (see *Connection
resilience* below); nothing typed is lost. Only a configuration problem (wrong password, bad connection string) makes it
fall back to memory only (nothing is saved); fix the setting and press **Retry connection**.

**Streamlit Community Cloud:** App settings → Secrets, same values as `.streamlit/secrets.toml.example`.
Never commit `.env` or `secrets.toml`.

## What's in the app

* **Cases:** Add Case asks whether you are entering an Aruba, AT&T or Foundation case, plus the day/time the case was received on the PET queue. A Foundation case is entered with its **SFDC Case ID** (that is its case ID) and its case detail has the SFDC Case ID only, no RITM. Inside the case: severity beside the Case ID, case status (FE Name, Tracking Number, Service Window, Scheduled, TR2, Resolved), multiple SFDC Case IDs, RITM number (Aruba), model number, lift required, maintenance window (start and end can be edited; every edit is written to the case history), part ordered / part delivered / CE arrival times. Closing needs all of these, then asks whether the SLA was met or missed (with the responsible party if missed). A RITM reminder pops up after closing.
* **Reports (Settings → Reports):** styled weekly Excel report, a report builder (choose, rename and reorder columns, save templates) and a dashboard with graphs.
* **Timezone and Data:** Settings → Timezone and Data sets the timezone for case times and the shift schedule (shared by everyone; a manager/coordinator changes it). Default is each device's own timezone.
* **Account names:** the same tab holds the account list. A manager/coordinator uploads an Excel or CSV file (one account name per row in the first column; a header row, blanks and duplicates are skipped; a template can be downloaded) and it replaces the previous list. The list feeds the optional **Account name** dropdown in Add Case and in Case Details (the account can be changed later and is logged). Accounts already saved on cases are kept if the list is replaced. The list is stored in the shared database as `config/accounts` (or on the device in local mode). Account Name is also available as a column in the report builder.
* **Bulk case upload (Timezone and Data → Upload cases):** a manager/coordinator uploads an Excel/CSV file; *Template* downloads `PET_Bulk_Case_Entry_Template.xlsx` with every case field plus the **case type** (Aruba / AT&T / Foundation), dropdowns and an Instructions sheet. Case type, case number (SFDC Case ID for Foundation), account name (must be in the account list) and the received time are needed per row; the rest is needed before a case can be closed. A preview lists rows with problems (skipped). **Only one reminder alert is created for the whole upload** and the new owners get **no assignment notification**.
* **Real account names:** accounts in the app/database are pseudonyms. Put the real names in Streamlit secrets as an `[ACCOUNT_REAL_NAMES]` table (`"Pseudonym" = "Real name"`, see `.streamlit/secrets.toml.example`) or as JSON in the `ACCOUNT_REAL_NAMES` variable. When an Excel report is downloaded the server swaps pseudonyms for real names (only for the accounts in that report); the screen, preview and database keep pseudonyms.
* **Same case number, several SFDC IDs:** in a bulk upload, rows that share an Aruba (or AT&T) case number are combined into one case holding all their SFDC IDs (blank fields are filled from the later rows; a different account on the same number is rejected).
* **Daily trend report (Reports → Daily trend):** created vs closed per day with pending cases at end of each day (chart + table), SFDC IDs received per day, average time to close, pending cases by age, and how long each case stayed in every bucket (average, longest, and a per-case table; the Excel timeline has one row per SFDC ID). *Download Daily Excel Report* gives three sheets (Daily trend with the chart image, Time in bucket, Case timeline) with real account names. Status changes are now timestamped (`sh` on the case); cases whose status was set earlier show their whole age in the current bucket.
* **One row per SFDC ID:** in the weekly report and the report builder (when the SFDC/HPE Case ID column is included), a case with several SFDC IDs gets one row per ID; the other columns repeat and the case count stays per case.
* **Layout:** the Settings window is wider so all tabs (including Reports and Simulation) sit on one line (they scroll sideways on a narrow screen). The case table starts with the **Account Name** column and no longer shows the revisit reason (just a Revisit badge). The weekly report lists the **AT&T Case Number** right after the account name.
* **Balancing at sign-in only:** when an agent signs in mid-shift and holds at least 2 fewer cases than the busiest agent on shift, cases move to them until the counts are within 1. It happens once, at sign-in; an agent who later has fewer cases because they completed some is not topped up. Untouched cases (newest first) move before worked ones, cases with a due reminder or a manual transfer are never moved. Balanced cases raise no new-case alert.
* **Weekly report:** **Account Name** is the first column and every report view can be filtered by account.
* **Agent case counts:** the Agent Status panel shows how many cases each agent was assigned today. A case counts for the agent it was first assigned to, even if it is transferred at end of shift (EOS agents who got cases stay listed). An agent who had a shift yesterday, got no case then and none today is marked ★ Priority and gets the next case first.
* **EOD support:** staff whose name, role or shift contains "EOD" are not listed in the Agent Status panel or counted in Available/Unavailable.
* **Closing:** account name is now also required before a case can be closed.
* **Instant load:** all saved data is sent with the first page render, so the dashboard fills immediately.
* **Case ownership:** marking yourself *Unavailable* only excludes you from new assignments; your open cases stay with you. The only automatic transfer is when the owner reaches the end of shift (EOS) set in the shift schedule; managers/coordinators can still transfer a case by hand.
* **Alarms:** every reminder rings twice, a warning before the ETA (editable, default 5 min) and again at the ETA.
  Agents can press *Later* to snooze (editable, default 5 min). Only alarms that trigger while a screen is open are
  shown; nothing old is replayed after a refresh or when someone opens the app.
* **Sounds:** one sound per alert type (Settings → Alerts), used by every alert including the simulation.
  A sound stops the moment its alert is closed, acknowledged or completed. No sound is embedded in the app.
* **Simulation:** runs only on the screen that started it and writes nothing to the database.
* **Shift schedule:** the PET Team layout (names in column A, SUN–SAT across the top, a time / OFF / PTO per day).
  The *Template* button downloads `templates/PET_Shift_Schedule_Template.xlsx` from the repo (the server reads the file on every download): to change the template, replace that file on GitHub and redeploy. A built-in copy is only used if the repo file cannot be reached.
* **Shift schedule saving:** every change (new person, name, role, each day, availability, delete, upload) is written to `config/staff` at once; a late echo of an older save can no longer overwrite a newer edit. *Export current* produces the same look as the template (dark header, orange/green shifts, pink OFF, dark-green PTO).
* **Checklist:** *Acknowledge* opens the alarm form (documentation required) for required items and for any item that has a reminder; +1 min / +5 min / +15 min / +1 hr add up on each click; the add field clears after adding.
* **Maintenance window:** enter the start first and set the end later (closing needs the end). Once a window exists, **Update maintenance window** records a new current window (as many times as needed): the original window and every earlier update are kept and shown as Original / Update 1, 2… / Current, and all of them appear in the report for RCA. **Edit maintenance window** only corrects the current window in place (typos).
* **Announcements:** there is no separate recipient picker: write `@everyone` to notify the whole team, or `@mention` specific people from the shift schedule (an announcement needs at least one of the two), tag cases, paste or upload images and GIFs (shared assets), emoji picker.
* **Sign-in:** a new sign-in starts clean; alerts queued or sent before it are not shown.
* **Dashboard:** header, "Operations Overview", stat cards (Total / Active / Due Reminders / Completed), the PET Cases table and the Agent & Agent Status panel follow the supplied design. Cases are sorted by next reminder (nearest first, no-reminder cases last) and the table has its own scroll bar. Filters for status, owner and reminder sit above the table.
* **Records:** only case updates are recorded (the Action History button was removed; `act` keeps case updates only).
* **Theme:** a shared image skin now travels inside `config/theme` itself (compressed), so other screens no longer download it separately; the base font is 14px.
* **Login page:** the app opens on this page when no profile is saved; a refresh keeps the signed-in profile (it is checked against the schedule/accounts first), and the header shows the profile in use. The team picture (a web picture and a mobile picture, with the sides filled on wide screens) is the way in. Every face is clickable. There is no close button: the dashboard can only be reached by selecting a profile or signing in (HPE email).
  * The two faces in the front are the managers: the woman is **Joerolyn Franquelli**, the man is **Jose Teves**. They are always in the shift schedule as managers and cannot be removed from it.
  * Any other face starts without a name. Clicking it asks only *Whose face is this?*: pick your name from the **shift schedule** (names already claimed are hidden) and the face becomes your profile for everyone; you are signed in straight away. Claims are stored in the `seat` collection.
  * From the next login, clicking your claimed face asks whether you want to add a password (*Not now* / *Set a password*; it asks again next time while none is set). Once a password is set, clicking that face shows a password pop-up every time before the profile opens. Password hashes stay in `config/profileHashes` (same as before).
  * *Sign in with HPE email* and *Sign up* (under the picture) are for people who are not on the shift schedule: sign up with full name, `@hpe.com` email and a password, then sign in. Accounts are stored in the `acct` collection. A name that is on the shift schedule cannot sign up; those people click their face. Members can see all cases but have no manager/coordinator rights.
  * The chosen profile is remembered on the device and changes only when another profile is selected (profile button in the header → login page).
* **Coordinators:** the old shared *Coordinator* profile is gone. A manager gives the coordinator role to a profile that already exists (a claimed face or a signed-up account) in *Settings → Profiles*; there can be several coordinators and only a manager can assign or remove them (`config/coordinators`). A coordinator keeps their own profile and gets the lead rights (add cases, edit the schedule, required checklist, reports, shared theme) and receives the coordinator alerts. The role changes on a signed-in screen as soon as the manager changes it.
* **Settings → Profiles** (manager / coordinator): list of profiles with their face, password and coordinator box; managers can also release a face, clear a profile's password or delete an account.
* **Mobile:** compact header, 2x2 tiles, stacked cases and agent panels, page scrolls normally and the case table scrolls sideways.
* **Case modal:** laid out as in the supplied design (priority / case ID / severity / status bar, owner card, Case Information + Transfer Details, Case Details, Work / Part Orders, Revisit, Checklists, Case History). The maintenance window end is optional but required to close the case. The simulation seeds a case with a start-only window and an announcement with a mention and case tag, and the Available / Unavailable toggle works for the simulated agent (restored when the simulation stops).
* **Date / time picker:** every date, time and date-time field opens a calendar with a searchable time list (type `9:30`, `930` or `9:23 AM`) and OK / Cancel / Now / Clear buttons. A maintenance window may start and end at the same moment.
* **Required checklist alerts:** in Settings > Required checklist every item has an alarm time (minutes after the case is added, with +1 min / +5 min / +15 min / +1 hr buttons that add up). The first item always keeps an alert; the others are optional. Stored in `config/requiredItems` as `{text,min}` (older plain-text items still work).
* **Theme on pop-ups:** colour themes and the image skin also apply to the pop-up modals (overlay tint, buttons, section headers, announcement colour; the image skin appears behind the pop-ups and in the case / settings headers). The default theme keeps the original pop-up look.
* **Theme (details):** Settings → Theme. Colour presets, a custom colour, an image skin (the app takes the image's colours) and
  font/size. A manager/coordinator can apply it to everyone; anyone can still use their own on their screen.

## Welcome page

After a sign-in (not after a refresh, which still opens straight on the dashboard) a welcome page greets the owner of the
profile. It uses the shared theme / skin that was uploaded for everyone and shows the face the person selected on the
team picture as their profile picture (initials if no face was selected). It lists what was missed while away:

* unread **mentions and case notices** (with a "Got it" button), **announcements** not yet acknowledged (opens the normal
  announcement pop-up), cases **assigned or handed over** since the last visit, **reminders due**, **high-priority** open cases;
* **Your day**: open cases, reminders due, high priority, cases today, today's shift and the "first in line" priority;
* managers / coordinators also get a **Team snapshot**.

Items that arrived after the last visit carry a NEW tag; the page updates live while it is open. "Last seen" is kept on the
device every 30 s and in the shared data (`seen` collection, one small document per person) every 5 min.

## Shift rules, availability and case table

- **Auto sign-out:** an agent who forgot to sign out is signed out automatically 20 minutes after their end of shift (EOS). Managers and coordinators are not affected.
- **Hand-over at EOS:** when an agent reaches EOS all their open cases are handed over at once to the agents on shift by the schedule (not within 30 min of their own EOS, not unavailable), evenly by workload. Off-shift agents never receive cases. If nobody is on shift, the cases wait for the first agent to start.
- **Manual hand-over and the queue:** an agent within 60 min of EOS can hand over all open cases; they go evenly to the agents on shift now. If nobody else is on shift the cases leave the agent and wait under the owner **Queue**, and go to the next available agent on shift automatically. New cases go to an agent on shift, or one whose shift starts within the hour; otherwise to the Queue.
- **Canceled status:** part ordered, part delivered and CE arrival times are greyed out and not required to close. **Cabling/HOD** tick box: part ordered and part delivered are not required.
- **New case entries:** a newly added case shows in bold with a blinking red **New** beside the case number and sits at the top of the case table (newest first), followed by cases ordered by the closest reminder. It turns regular once its owner opens it.
- **No new cases near EOS:** an agent within 30 minutes of EOS is not assigned new cases. If nobody else is on shift, the case goes to the next agent to start.
- **Unavailable reason:** switching to Unavailable asks for a reason (Break, Lunch, Coaching, Admin, Other; Other takes a short note). The reason shows in Agent Status and in Settings.
- **Case table:** 100 cases per page with Previous / Next. The search box still searches every case, on any page.
- **Welcome page:** also lists cases assigned back or handed over to you; cases with a reminder are highlighted (red when due, amber when upcoming).
- **Maintenance windows:** besides Update and Edit, a case has **Add new maintenance window**. There is no limit; the newest window is the current one and every earlier window is kept (listed as Original, Update n, Window n in the case and in reports).
- **Hand over before EOS:** an agent within 60 minutes of EOS (or up to 2 hours after) sees a banner to hand all open cases to the agent scheduled to be available next (two clicks to confirm). The receiver gets one summary notice.
- **Alerts are shown once:** reminders, announcements and mentions that were already shown or acknowledged are remembered on the device and are not replayed after reopening. Acknowledgements and face claims also stay put while the server is still saving them.
- **Live counts:** "Cases today" in Agent Status updates in real time; changed data is pushed with the reply instead of a second fetch.

## Settings

| Variable | Meaning |
|---|---|
| `MONGODB_URI` (or `MONGO_URI`) | connection string, default `mongodb://localhost:27017` |
| `MONGODB_PASSWORD` | replaces `<db_password>` in the URI (URL-encoded for you) |
| `MONGODB_DB` (or `MONGO_DB`) | database name, default `pet_station` |
| `PET_APP_PASSWORD` | optional password asked before the app is shown |

Each app collection (`cases`, `act`, `ann`, `acks`, `mentions`, `seat`, `acct`, `config`) is a MongoDB collection of the same name.
Shared audio is in `_assets` (max 10 MB) and live-update counters in `_meta`.

## Notes

* Concurrent edits are last-write-wins per saved field (the app patches only changed fields).
* Profile passwords are salted hashes stored in `config/profileHashes`; they identify people inside the app but are
  not server-side authentication. Use `PET_APP_PASSWORD` (or SSO in front of Streamlit) to restrict access.

## Speed and live updates

* The browser checks for changes about once a second and sends one message at a time, so a slow connection cannot
  cut a save off. Saves go out at once and are answered in the same run.
* The server keeps the change counters and the last read of each collection in memory: the once-a-second check and a
  re-read of unchanged data do not wait for MongoDB. Every write updates them immediately (counters are also re-read
  from MongoDB every 2 seconds).
* The dashboard only rewrites a panel when its content changed, and a hand-over of many cases redraws once.
* Checklist / revisit documentation keeps its line breaks and paragraph spacing (saved, shown and exported).
* After updating `streamlit_app.py` or `web/shim.js`: **Reboot app** in Streamlit and hard-refresh the browser.

## Test

```bash
python -m unittest discover -s tests -v   # store, requests and sync protocol
node tests/shim_integration.js            # real app + shim + Python bridge, two simulated browsers (needs Node)
node tests/feature_checks.js              # schedule saving, export, acknowledge, reminders, maintenance window, announcements, sign-in
node tests/slow_server.js                 # saves and live updates against a slow, Streamlit-like server (DB_MS=250 for slower)
# optional, needs Playwright + Chromium: two real browser screens against the real bridge
python tests/live_host.py . 8765 &  node tests/live_browser.js 8765
```

## Login page, seasonal design and sign-in timeout

- **Team picture:** new web and mobile pictures. June John Cruz (Vendor Management) stands at the back and has his own fixed face with the same access as a manager. Every earlier face id is kept, so faces that were already claimed stay claimed.
- **Login page (DIY):** Settings → Theme → Login page (DIY), for managers only. Upload a web picture (and, optionally, a mobile picture), drag a box over each face or object, and either fix it to a profile or leave it for an agent to claim. Saved in `config/landing`, with the pictures in the asset store, so no code change is needed. Boxes moved from the current picture keep their claims. "Use the built-in team picture" switches back.
- **Seasonal theme & effects:** Settings → Theme → Seasonal theme & effects (changed by managers only; everyone else sees it read-only). Managers choose Christmas, New Year, Valentine's or Halloween and the yearly dates (default Christmas, Nov 1 to Dec 31). The design shows only between those dates and disappears on its own afterwards. Christmas adds string lights on the header, falling snow, a Santa hat on the logo, candy-cane trim on the panels, a tree with the agents' names on gifts and a countdown on the welcome page, a waving Santa in announcements, and Santa's sleigh pulled by elves across the cases table every 10 minutes. Each extra can be switched off; anyone can hide the effects on their own screen. Saved in `config/season`.
- **Sign in again after 8 hours idle:** after more than 8 hours without any click, key press or scroll, the app signs the person out (or does not restore the saved sign-in when it reopens), so the welcome page shows what changed when they sign in again.
- **Profile button:** the switch-profile button was removed from the header; Log out does the same.
- **Seasonal login picture:** in Seasonal theme & effects a manager can add a login picture for the season (same editor, starting from the current faces so claims carry over). It replaces the login page only while the season is showing and the everyday picture comes back by itself when it ends.
- **Fairy lights:** blinking fairy lights hang along the top of the cases table, the Agent Status panel, the login picture and the welcome page's Christmas card (on top of the string lights on the header). Can be switched off.
- **Naughty-list Santa:** while the Due Reminders tile blinks, about once a minute Santa pops up above the tile, waves, and then a bubble says "Ho ho ho! You are being naughty!" (or a similar line). Can be switched off.
- **No switch-profile button:** the header keeps only Log out, which does the same.
- **3D-style characters:** Santa and the reindeer pulling the sleigh are drawn with soft shading, highlights and shadows (the lead reindeer has a glowing red nose and the reindeer gallop).
- **Naughty List bubble:** Santa's bubble now says they are being naughty and are on his Naughty List (three rotating lines).
- **Light and smooth:** every seasonal animation uses only transform and opacity (no layout or repaint work), the sleigh moves with transform, settings are kept in memory instead of being re-read every second, and nothing seasonal reads or writes the database except when a manager saves. Measured at 60 fps with all effects on and 60 cases, with no long tasks.
- **Santa stays until the tile is clicked:** naughty-list Santa now stays above the blinking Due Reminders tile. When the tile is clicked (or the reminders are done) and the blinking stops, his bubble changes to a Nice List message ("you're back on my Nice List!") and he leaves after a few seconds.
- **Christmas corner:** the tree with the agents' names on the gifts and the countdown to Christmas now sit at the bottom of the Agent Status panel (instead of the dancing Santa, which was removed, and instead of the welcome page).
- **Gift announcement:** in the Christmas season an announcement opens like a present: the gift shakes, the lid pops off with confetti, Santa springs out like a jack-in-the-box, and then the announcement card pops in.
- **Sleigh every 10 minutes:** Santa and his sleigh cross the cases table every 10 minutes (and once about 20 seconds after the dashboard opens).
- **Elves in the case and alert windows:** in the case window one elf sits on the header (the title makes room for him), one scribbles on a notepad in the Case Details header, and one drags gift sacks along the bottom. In alert pop-ups (reminders, mentions, announcements, availability) lights hang along the top of the card, an elf sits on its top edge, one writes beside the card and one drags the sacks underneath, but only where there is empty space, so no field, text or button is covered.
- **More lights:** blinking lights also run along the tiles row, the case window header and section headers (with room made for them), and the welcome page cards.
- **Countdown greeting:** "Merry Christmas from the Partner Engagement Team and Vendor Management Team!"
- **Login picture fills the screen:** on any screen shape (and for any uploaded picture) the space around the picture is filled by stretching and softening its own outer edge, so there are no empty bands and nothing is cropped (every face stays clickable). At Christmas the edges also get leafy vines with poinsettias and holly berries, plus poinsettia bouquets in the corners.
- **New team picture (web and mobile):** adds Jeff Bote (Vendor Management Team - Manager, the man in the middle doing the hand sign) and Arianne Escabillas (Vendor Management Team - Developer, standing on the right), both with full manager access. June John Cruz is now Vendor Management Team - Auditor with the same access. Everyone else keeps their face id, so claimed faces stay claimed.
- **Vendor Management Team and the schedule:** June John Cruz, Jeff Bote and Arianne Escabillas are left out of the Shift Schedule table and its Excel export (they never take cases).
- **"New" clears on the owner's click:** the first time the case owner opens a new case it turns regular at once; the click is also remembered on that screen, so a slow save or an older copy from the database cannot bring the bold "New" back.
- **Cases table height:** on wide screens the cases table is exactly as tall as the Agent Status panel beside it (Christmas corner included, at least 560 px) and scrolls inside.
- **One Arianne profile:** "Arianne May Escabillas" and "Arianne Escabillas" are the same person and are merged into Arianne Escabillas (Vendor Management Team - Developer, full access, fixed face on the right of the picture, not on the shift schedule). Anything saved under the old name follows automatically: the signed-in profile, her password, and her open cases (handed to the agents on shift, or the queue if nobody is on shift). A face she had claimed earlier is freed for someone else.

## Hand-over and balancing rules (applied from the rules checklist, Nov 12)

- **Online agent** = on shift by the schedule, Available, and not within 30 minutes of their own EOS. Managers and the Vendor Management Team never receive cases. Unavailable agents get no new cases and no hand-overs.
- **New cases** go to an online agent (priority first, then fewest cases). Nobody online: the case waits and goes to the first agent who is online. It is no longer given to someone whose shift has not started.
- **End of shift:** the leaving agent's open cases are divided equally between the agents online (round robin). Nobody online: they stay with the leaving agent and go to the first agent who starts or becomes available. A case handed over by hand stays with its new owner until that owner's next EOS.
- **Hand-over by hand** (banner from 60 minutes before EOS, two clicks): divided equally between the agents online. Nobody online: the cases stay with the owner, marked "Hand-over requested", and go out automatically as soon as someone is online. There is no separate queue for hand-overs any more.
- **Balancing at sign-in:** every agent online gets an equal share of the open cases; excess is clawed back from the busiest agents. Cases that were the new agent's before go back first, then untouched cases, then worked ones (newest first). Cases with a reminder due can be moved; cases a person transferred by hand to their owner are not.
- **Productivity:** every agent who handled a case gets one count, on the day it was assigned to them.

## Connection resilience and smoothness (Nov 12)

* **Hardened MongoDB connection:** automatic retry of reads and writes after a dropped connection (`retryWrites`,
  `retryReads`), idle sockets recycled after 60 s before Atlas closes them, bounded timeouts (nothing can hang the page),
  a small always-open connection pool, and a background ping every 25 s that keeps the connection warm and notices an outage
  early. Options written in your connection string still win.
* **Quiet retries on the server:** a call that hits a dropped connection or an Atlas primary switch-over is retried with a
  short back-off (up to 6 s). Real errors (bad data, wrong password) are not retried.
* **No more silent "memory only" mode on a network blip:** if MongoDB is unreachable at start or later, the app stays on
  MongoDB in "reconnecting" mode and recovers by itself as soon as MongoDB answers — no reboot or "Retry connection" needed.
  While it is down, calls fail fast (one reconnect attempt every 2 s) so the page never freezes, and the last known data
  keeps showing.
* **Saves are never dropped:** in the browser, a save that could not be completed is kept and sent again automatically
  (back-off up to 8 s, for up to 15 minutes). It is also kept in the browser's storage, so even if the page is reloaded or
  closed during an outage, the next page sends it (only changes less than 10 minutes old, so newer data is never
  overwritten). A small amber badge "Reconnecting to the database — your changes are kept and will save automatically"
  appears only while this is happening; the "Could not save" pop-up no longer shows for a temporary disconnection.
* **Smoothness check (60 cases, all Christmas effects on):** 60 fps steady, no long tasks; a full dashboard redraw takes
  about 1.3 ms and the once-a-second seasonal/upkeep work about 0.3 ms.
* `.streamlit/config.toml` turns off Streamlit's file watcher and usage stats (less background work on the server).
* Tests: `tests/test_reconnect.py` (server retries, outage, automatic recovery) and `tests/shim_reconnect.js` (browser keeps
  and resends saves, replay after a reload).


## Round robin for new cases and handover/new counts (Nov 13)

* **New cases are assigned round robin.** Each new case (Add Case, bulk upload, or a case that waited in the Queue) goes to
  the agent on shift and available whose last new case is the oldest; an agent who has not had one yet goes first. So
  everyone on shift takes a turn before anyone gets a second new case, no matter how many cases they already hold. Ties go
  to the ★ priority agent, then the order of the shift schedule. Off-shift, unavailable, near-EOS agents and the Vendor
  Management Team are skipped. Hand-overs and balancing do not change whose turn it is (stored per case as `rr`).
* **Agent Status → Cases today** now shows two counts: **↪ handover** (cases handed to the agent today by end of shift,
  manual hand-over or balancing) and then **new** (new cases received today). On a phone the two counts stack.

## Vendor Management titles and New Year season (Nov 13)

* The name/role chip between the gear and Log out now shows the Vendor Management title: **Auditor · June John Cruz**,
  **Developer · Arianne Escabillas** (the same person as Arianne May Escabillas), **Manager · Jeff Bote**. Hover shows the
  full title. The welcome page and the Profiles list use the same titles.
* June John Cruz (Auditor) has the same access as a manager. Arianne (Developer) has every manager permission, plus
  developer-only protection: only she can clear her password, release her face or delete her profile.
* A Vendor Management member still signed in from an older agent sign-in is upgraded to manager access automatically.
* **Countdown:** from Christmas Day the countdown below Agent Status counts down to New Year.
* **New Year (Dec 31 – Jan 7, follows Christmas automatically; "Then New Year" option in Seasonal theme & effects):**
  fireworks (a short show every 3 minutes, a bigger one at midnight), a flashing "Happy New Year 2027!" banner above the
  tiles (New Year's Eve: "2027 is almost here!"), a big "Happy New Year" flash with fireworks once a day when the dashboard
  opens, gold confetti, a gold header garland, and a navy/gold corner with a clock, champagne, balloons with the agents'
  names and the countdown (then "Happy New Year 2027!"). Christmas-only decorations (Santa, elves, sleigh, fairy lights)
  end when New Year starts. Managers can also pick New Year as its own season with its own options. Fireworks pause in a
  hidden tab and while a case or Settings is open; nothing blocks clicks. Measured: 60 fps during fireworks.

## Catch-up balancing (Nov 13)

* An agent who has not received any hand-over since signing in — because they were Unavailable, their shift had not started
  yet, they were close to end of shift, or the data was still loading — now gets their equal share of open cases from the
  other agents online as soon as they can take cases (Available, on shift). The same rules as sign-in balancing apply
  (their own former cases first, manual hand-overs stay put).
* It is checked every 30 seconds in the agent's own browser and happens once per sign-in: it stops as soon as the agent has
  received a hand-over, or if they already hold an equal share (nobody is given cases just because).
* Fix (Nov 13): agents tagged as **coordinator** were skipped by sign-in and catch-up balancing. They now get hand-over
  cases like every other agent. The shared "Coordinator" sign-in, managers and the Vendor Management Team are still never
  given cases.

## No shared Coordinator sign-in (Nov 13)

* The leftover shared "Coordinator" identity is removed. A coordinator is an agent tagged as coordinator in Profiles: they
  sign in with their own face/name, act and are logged under their own name (no more "Coordinator" in case history,
  announcements or acknowledgements), see "My Cases" as their own, and keep the coordinator extras (see all cases,
  monitoring alerts, settings a coordinator may use).
* Coordinators receive cases like every agent: new cases by round robin and hand-overs (end of shift, manual hand-over,
  sign-in and catch-up balancing).
* Announcements no longer list a separate "Coordinator" recipient.

## Coordinator access (Nov 13)

* An agent tagged as coordinator has manager access except three things that stay manager-only: changing other people's
  role (the Coordinator tick), the seasonal theme, and the login page / login profile faces (DIY).
* Release face, Clear password and Delete member account in Profiles are for managers and the Vendor Management Team only
  (changed Nov 13). Coordinators keep everything else they had (all cases, Reports, Required checklist, schedule, timezone,
  uploads, alerts, monitoring) and still receive new and hand-over cases.

## Hand-over round limits (Nov 13)

* Every hand-over (EOS, hand-over by hand, cases waiting for an available agent, balancing) is dealt **one case at a time**
  to the agent online with the fewest hand-over cases this shift, up to the **round limit**: 15 per agent in round 1; when
  every agent online has 15, the limit becomes 25, then 35, and so on, until every case is assigned.
* What counts toward the limit: hand-over cases received since the start of the agent's shift that are still theirs, open
  or closed. Closing cases quickly does not bring more cases; a case moved away by balancing stops counting for the giver.
* **New cases are not counted**: they are dealt round robin on top of the hand-over limit, and never moved by balancing.
* An agent who was Unavailable, signed in late or whose shift starts later is filled up to the round in progress as soon as
  they can take cases (checked every 30 s, again each time they come back from Unavailable), from the agents with the most
  hand-over cases, never leaving a giver below the receiver. Own former cases go back first, then untouched ones; cases
  handed over by hand to someone stay with them.
* Agent Status shows the round in progress, e.g. "Hand-over round 2 · up to 25 each".
* Fix found by simulation (Nov 13): catch-up stopped when the agent with the most hand-over cases had already closed all of
  them. That agent is now skipped and cases come from the next agent who has open ones.

## Hand-over and balancing rule conflict check (Nov 13)

Audit of every place that assigns cases, plus `tests/rules_conflict_check.js`: random shifts, statuses, EOS, new cases,
closures and catch-ups run through the real app code, and every assignment is checked against the rules (never managers;
nothing left off shift or in the Queue while someone is online; only online agents receive; fewest hand-overs first / round
robin for new cases; a giver never ends below the receiver; running again moves nothing; new cases never moved by balancing;
round limit respected). 0 violations; the checker was verified by deliberately breaking the rules (it caught every break).

Conflicts found and fixed:
* Other assignment paths (a person removed from the schedule, an owner missing from an uploaded schedule, the "at EOS it will
  go to…" preview) still picked the agent with the fewest cases in total, set the owner silently and did not count it as a
  hand-over. They now follow the hand-over rule (fewest hand-over cases this shift), are logged, and count toward the limit.
* Agent Status "handover" showed cases received today (calendar day, including ones moved away) while the round limit used
  this shift's count. It now shows the same count the round limit uses.
* Every open screen ran the automatic EOS hand-over each second, so two screens could hand the same case to two agents in
  the same second. Now one screen at a time does it (20-second lease in the database; another screen takes over if it closes).
* The EOS banner still said cases are "divided equally"; it now describes the round limits. Unused old equal-split code removed.

Known by design (not conflicts): a coordinator's manual transfer can go above the round limit and is never moved by
balancing; cases of an agent who is Unavailable stay with them; cases are counted one each, whatever the severity.

## Hand-over formula, worked-only productivity and checklist attribution (Nov 13, evening)

* **Hand-over formula (replaces the 15/+10 round limits):** total hand-over cases ÷ available agents.
  * A batch (end of shift, hand-over by hand, cases waiting for an available agent) is split equally between the agents
    online: 100 cases ÷ 4 agents = 25 each. All agents leaving at the same time form one batch.
  * Each time another agent becomes available (signs in on shift, starts their shift, comes back from Unavailable), the open
    hand-over cases are divided by one more agent: 100 ÷ 5 = 20, so the new agent gets 5 from each. A giver never drops below
    the receiver; givers with no open hand-over case are skipped.
  * New cases (round robin) are not part of the total; they come on top.
  * The formula works in the background only: Case History shows a plain line ("… reached end of shift (EOS): case handed over
    to …", "… became available: hand-over case moved from …") and Agent Status shows only each agent's counts — hand-over
    cases counted as their productivity, then new cases received.
* **Productivity / Agent Status "handover":** a hand-over case counts only for an agent who updated it — added information
  (any case detail), added, completed or acknowledged a checklist item, set a reminder, added a work order, tagged a revisit
  or closed it. A new case still counts for the agent who received it.
* Every piece of information added in the case window is written to Case History (checked for every field and button).
* **Checklist items** show who added them and who completed / acknowledged them, with the time ("Added by Kenjie · 7:41 PM ·
  Completed by Karen · 7:41 PM"); older items take this from the case history; template items show "Added by System".

## Checklist applied (Nov 13, 8:45 PM)

* Dropped "balancing runs once per sign-in": the catch-up check now repeats every 30 seconds until the agent actually holds
  their share (a first check that found nothing movable no longer ends it). Once they hold it (or are within one case, or
  nobody has 2+ more), it rests until they next become available, so closing cases later does not pull in more.
* Dropped "agents involved in a move get a pop-up": automatic hand-overs and balancing moves no longer show a pop-up; the
  line in Case History stays. A manager or coordinator who transfers a case by hand still sees their own confirmation.
* All other 38 rules kept as they are.

## Naughty-list Santa stays until every due reminder is cleared (Nov 13)

* Santa pops up on the Due Reminders tile as soon as a case reaches its due time and stays there until **all** due reminders
  are cleared — clicking the tile (which stops the blinking) no longer sends him away.
* Each time a case reaches due he names its owner(s): "Ho ho ho! 🎅 Karen Sabile, you have been listed on my Naughty List 📜 —
  a case reached its due time!" (several owners are named together: "A, B and C").
* When an owner's due reminders are cleared: "✨ Kenjie Locsin is off the Naughty List — due reminders cleared! 🎁" (green).
  Between announcements his bubble shows the current list: "📜 Naughty List: … — clear the due reminders to get back on the
  Nice List!"
* When nobody is left: "… everyone is on the Nice List! 🎁" and he leaves.
* Light: the list of owners is collected in the dashboard's existing once-a-second pass (no extra scan) and the bubble is
  redrawn only when the list changes. Measured with 60 cases, Santa, sleigh, fairy lights, snow and the Christmas corner:
  58–60 fps, no long tasks.
* Update (Nov 13, 9 PM): each owner is listed once with the number of due cases beside the name ("Kenjie Locsin 10x"); another
  due case for the same owner only raises the count ("Kenjie Locsin 11x — another due case added to your count…"). An owner
  who was cleared off the list earlier today and comes back: "😄 Looks like we have someone who enjoys the Naughty List —
  Kenjie Locsin 1x is back on it!"
* The bubble never covers anything important: Santa stands on the part of the Due tile's top edge with no text, and the
  bubble tries beside him (right / left), level with his feet and above his head, keeping the spot that touches no text,
  button or tile number. If every spot would cover something, the message is shown in a strip right under the tiles (it takes
  its own space). On phones Santa and his message always sit in that strip.
* Placement is worked out only when the text or the tile position changes. Measured: 58–60 fps with all effects, no long tasks.

## Idle sign-out rules and the Agent productivity & due misses report (Nov 14)

* The 8-hour inactivity sign-out no longer applies to managers and the Vendor Management Team.
* An agent signed out for inactivity comes back as **Available** when they sign in again.
* **Settings → Reports → 🏅 Agent productivity & due misses** (same date range / account / case type filters, CSV download):
  * Per agent: new cases received, new cases updated, hand-over cases received, hand-over cases updated, update rate,
    productivity (new received + hand-over updated, the same count as Agent Status), cases closed, due misses, average and
    longest time to acknowledge, and reminders still unacknowledged.
  * Due misses list: every reminder that reached its due time before anyone acknowledged it, counted for the person who
    owned the case at that moment. If it was still unacknowledged when the case moved to the next agent it stays counted for
    the first owner (the note says who it was handed to). Shows who acknowledged it, when, and the time until acknowledged.
  * Back-tracking: cases now keep an exact ownership history (`ownh`); older cases are rebuilt from Case History
    ("Ownership transferred" and "Reminder ETA reached" lines), as far back as their history goes.
* Clarified (Nov 14): "Available on sign-in" applies only to an agent signed out because they were inactive for more than
  8 hours (including coming back to a screen left idle over 8 hours). An agent who is signed in and on a break or lunch keeps
  their status, and signing out and in by hand never changes it.
* **Performance monitor** (top of the Agent productivity & due misses view, also in the CSV): agents grouped by shift, with
  follow-through (update rate, aim 80%+), due misses per case handled (aim ≤ 0.1), average time to acknowledge (aim ≤ 30 min),
  output vs the shift's median productivity, the update rate for each of the last 4 weeks with a trend arrow, and a status
  with the reason: **Strong** (80%+, ≤ 0.1 misses per case, ≤ 30 min, nothing open), **Needs coaching** (under 50%, 0.3+
  misses per case, 2+ still open, or over 2 h to acknowledge), **On track** in between, **Not enough data** under 5 cases.
  "Last 14 days (recommended)" button; Needs coaching is listed first in each shift.

## Nov 14 (afternoon): closed cases, name merge, regional performance dashboard, realtime and speed

* **Closed cases** never take part in hand-over or balancing (blocked at the single place every move goes through). When an
  agent closes a case it is tagged to them (owner = the agent who closed it, `closedBy` kept). Closed cases that had been
  moved after closing are returned once, automatically, to the agent who closed them (or, if a manager closed it, to the
  owner at that moment) — logged in Case History.
* **Bonnylet Manalo = Bonylett Manalo** (the schedule's spelling is kept). Names are merged everywhere they are read: case
  owners, hand-over credits, ownership history, checklist and Case History, so the reports count one person.
* **Performance dashboard** (Reports → Agent productivity & due misses): grouped by **region — APJ, EMEA, AMS** — taken from
  the start time each agent works most on the shift schedule (Manila time: 05:00–11:59 APJ, 12:00–19:59 EMEA, 20:00–04:59
  AMS). The region is remembered with a date whenever the schedule is saved, so a schedule change never moves earlier
  records. Each region shows summary cards (cases handled, team follow-through, due misses, average time to acknowledge),
  a 4-week follow-through trend chart, and per agent bars for follow-through (80% target line), due misses per case and
  productivity. Only agents who are clearly not performing are highlighted in red ("Needs attention": under 40% updated,
  3+ due misses at 0.3+ per case, 3+ reminders left unacknowledged, or over 4 h on average to acknowledge; at least 8 cases).
  Full numbers and the due-miss list are folded underneath; the CSV includes the region.
* **Realtime**: the server now remembers which documents each change touched and sends a browser only the changed
  documents since its copy (one case instead of the whole collection); the browser applies them in place. Coming back to
  the tab asks for the latest immediately. Another person's change shows within about a second, without a refresh.
* **Speed / no visible refresh**: the browser↔server heartbeat runs inside a Streamlit fragment, so only that small part
  re-runs (requires Streamlit 1.37+, now in requirements.txt; older versions fall back to the full re-run). On screen, a
  dashboard section is rebuilt only when its content changed, and an open case only when that case changed — no flicker,
  open drop-downs stay open, animations don't restart. Measured with 120 cases: 60 fps, no long tasks, 1.3 ms per redraw.

## Case History fix (Nov 14, evening)

* Cause: the history of every case was taken from one shared activity list, of which only the newest 1,000 entries are
  loaded. As the team logged more actions, older entries of a case fell out of that window and disappeared from its Case
  History. Also, on a shared screen a new entry appeared only after the server echoed it back.
* Fix: every entry is now also stored inside the case itself (newest 400 per case), and Case History shows both sources
  merged without duplicates — a case keeps its full history however busy the team gets. New entries appear instantly.
* Two owner changes were not written to the history at all; now they are: renaming a person on the shift schedule (their
  cases follow the new name) and merging a duplicate name (e.g. Bonnylet → Bonylett Manalo).
* Entries from earlier days show the date as well as the time.
* Note: entries that had already dropped out of the 1,000-entry window before this fix cannot be shown again unless they
  are still in the database's activity list; everything from now on is kept.

## Every action in the case history, and faster opening (Nov 14, night)

* **Case History** is complete again for every case: the complete history of a case is loaded from the database when the
  case is opened (one quick filtered read, indexed), so entries older than the dashboard's newest-1,000 window show too —
  including who added, completed, acknowledged or edited each checklist item (old items get the names from their history).
  Reports load all history entries of the chosen period, so productivity and due misses count older cases correctly.
* History is stored once (the activity list, kept forever) — the copy-inside-the-case approach from earlier today is
  stopped so case documents don't grow and slow the app down (entries already stored that way are still shown).
* Checklist items now also show **Edited by** (name and time) when their text was changed.
* **Faster opening (browser and phone)**, measured on a phone with a slowed-down processor: about 2 s → 0.9 s until the
  styled page shows, before even counting the downloads removed:
  * Tailwind styles are pre-built into the page instead of being compiled in the browser at every start
    (visually identical, checked screen by screen; `tools/tailwind_tokens.py` + `tools/tailwind_build.js` rebuild them).
  * The two Excel libraries (~2 MB) no longer block the page: they load quietly a few seconds after start, or at once when
    an upload / download needs them.
  * The two login pictures (~0.75 MB of text inside the page) are served as separate image files, downloaded in parallel and
    cached by the browser; the page is less than half the size.
  * The first load sends only the newest 1,000 history entries and cases (what the page shows) instead of the oldest 3,000
    history entries, which the page then had to replace.

## Balancing fix: cases move as soon as an agent becomes available (Nov 15)

Why cases were not moving to a newly available agent (rules that got in each other's way):

* **Balancing ran only in the joining agent's own browser** (checklist rule "the check runs in the agent's own browser").
  If her tab was closed, in the background or on a sleeping phone, nothing moved. Now the one screen that already runs the
  automatic EOS hand-over also does balancing, every 5 seconds, for any agent who became available, whether or not her own
  browser is open. Her own browser stays as a backup only when no other screen is running it (two screens moving cases at
  the same time could give her twice her share).
* **"Done" was remembered per sign-in**, so an agent who stayed signed in from one shift to the next was never balanced at
  her next shift start. It is now remembered per availability: shift start, sign-in on shift, or back to Available. Each
  one starts a fresh check; after she holds her share the check rests until the next one (unchanged rule). Done marks are
  stored in `config/baldone`, so a screen taking over does not repeat them. Sign-ins are signalled with a small document per
  agent (`avail/<name>`), not by rewriting the staff list.
* **Agents ending their shift soon were not asked to give first**: cases were always taken from whoever held the most
  hand-over cases. Now an agent whose shift ends within the next 4 hours gives first (soonest EOS first, only down to the
  share, never below the receiver), then the busiest. Those cases would be handed over at their EOS anyway.
* Back to Available now balances straight away (it used to wait for the next 30-second check).

Unchanged on purpose (your checklist): new cases are not counted in the share and never moved by balancing, and cases a
person transferred by hand stay put. So an agent with 2–4 hours left whose load is mostly **new** cases keeps those until
her EOS, when all her open cases are handed over.

Checked: new feature checks (shift start with no browser open, near-EOS agent gives first, new cases stay, rests after
share, back from Unavailable, sign-in, next shift, own browser stays out while another screen balances) and the rule
conflict fuzz now also runs the hand-over screen's balancing (60 scenarios, 0 violations, a second run moves nothing,
also with the agents' own browsers switched off).

## Productivity & due misses report update (Nov 17)

* **Every update counts for productivity.** Any case an agent updates counts: a value in a field, a checklist item, a
  maintenance window (set, updated, added, edited, end set), a reminder, closing it, and so on. Each update also marks the
  case with the agent and the day (`wk` on the case, one time per day per agent), so the count no longer depends on the
  case history being loaded. A case updated on a later day counts on that day too.
  **Productivity = new cases received + cases updated, one per case per agent per day.** Several fields or updates on
  one case on the same day count as 1. If the agent updates the same case again on another day (for example after
  receiving it again), that counts 1 for that day. The day a new case was received is already counted under New cases
  received, so updating it that day adds nothing. A hand-over case counts on the day the agent updates it. A period
  total is the sum of its days. The full numbers table has the column **Cases updated (1 per case per day)**. Agent
  Status's first number is the cases (other than that day's new ones) the agent updated that day.
* **Numbers instead of bars.** The per-region table shows Productivity, Follow-through, Due misses, Due misses per case
  and Avg time to acknowledge as centred numbers. The full numbers and due misses tables are centred too (long text
  columns stay left-aligned).
* **Graphs.** "Productivity and due misses per day" for the period (last 31 days at most), and "Productivity and due
  misses per agent" in each region. The numbers are written on every bar.
* **Excel instead of CSV.** "⬇ Download Excel" builds a formatted workbook. It has a Dashboard sheet (Needs attention rows
  in red, with the per-day chart and one chart per region), Productivity (full numbers, total row, chart), Per day (with
  chart) and Due misses.
* **Daily trend:** "Net" is now **Variance** (created − closed), on screen and in the Excel file.

One-time changes to data, like merging a person, profile or account, are done straight in the database with a separate
script that is run once. They are not added to the app.

## Productivity report: one row per agent, breakdown, guide, agent view (Nov 17, later)

* **One row per agent, in the current region.** Counts that were split by a schedule change or a time-zone difference
  are combined, and the agent is shown in their current region (today's schedule, else the last region remembered).
  This replaces the Nov 14 rule that kept older records in the earlier region. The one-time region script for
  Jovi Martinez is no longer needed.
* **Productivity breakdown** (each count is 1 per case per day):
  * New cases received: each new case counts 1 on the day it was received.
  * Hand-over cases updated: hand-over cases the agent updated, 1 for each day they updated it.
  * Own cases followed up: the agent's own new cases updated again on a later day.
  * Other cases updated: a colleague's case the agent updated.

  Productivity is the sum of these four. The full numbers table is grouped into
  ① Received → ② Updated (follow-through) → ③ Productivity → ④ Due reminders, with a Total row. The dashboard table has
  a Breakdown column ("6 new + 4 hand-over + 1 follow-up + 0 other").
* **Guide:** "ⓘ Guide: what each column means" sits above the full numbers table and is the first sheet (Guide) of the
  Excel file. The Excel file also has the breakdown columns.
* **Agents see it in their profile:** Settings → **🏅 My productivity**. It is the same report, showing only their own
  numbers, with their region's average per agent to compare. It has the same charts, due misses list, guide and Excel
  download. Managers and coordinators keep the full Reports tab.

## Scorecard and the New tag (Nov 17, later)

* **Scorecard** (Reports → 🎯 Scorecard; agents see their own card at the top of Settings → 🏅 My productivity). Each
  agent's score out of 100:

  | Measure | Points | Full points when |
  |---|---|---|
  | Follow-through (cases updated ÷ received) | 30 | 80% or more |
  | Due misses per case | 25 | 0.15 or less (no points at 0.5) |
  | Average time to acknowledge | 10 | under 1 hour (no points at 8 hours) |
  | Productivity per active day, compared with the region average | 25 | 90% of the average or more |
  | Due reminders still unacknowledged | 10 | none (1 left = 5 points, 2 or more = 0) |

  Status: On track 85+, Watch 70–84, Below target under 70. Agents with fewer than 8 cases in the period are not scored.
  Each card shows the last 4 weeks of scores and the productivity breakdown. Managers and coordinators can add a context
  note for the month (stored in `config/scnotes`), and the agent sees it on their card. Opening the Scorecard selects the
  last 28 days. The Excel download has a Scorecard sheet.
* **New tag:** only a case added with **+ Add** (or the bulk case upload) shows as New, for the agent it was added for.
  A case that is handed over at end of shift, balanced or transferred loses the tag. Older moved cases that are still
  flagged in the database are not shown as New either.

## Bulk cases, developer access, automatic EOS aux (Nov 17, later)

* **Bulk upload = old cases, never new.** Only a case added with **+ Add** is a new case. Cases loaded with the bulk upload
  have the original owner "Bulk upload" (`BULK`). They are given to agents like hand-over cases (not by the round robin),
  are never tagged New, and are not counted as "new received". An agent gets productivity for a bulk case when they
  update it, the same as a hand-over case.
* **Developer access:** on the password prompt of any profile, the Developer's own profile password also opens it (for
  maintenance), with the note "Opened with developer access". The Developer needs a password set on her own profile.
  Everyone else still needs that profile's password.
* **Automatic aux EOS:** when an agent's shift ends, the screen that runs the hand-over sets them to Unavailable · EOS.
  When their next shift starts it is set back to Available (only if it is still the automatic EOS), so they get cases
  again as before. An agent who switches back to Available after EOS (overtime) is not set to EOS again for that shift.
  EOS is not in the list of reasons an agent picks by hand.

## Productivity = updated cases only; 1–5 scorecard; name merges from the database (Nov 17, later)

* **Productivity = old cases updated (hand-over / balanced / bulk) + new cases updated**, one per case per day. A case that
  was assigned but not updated does not count. A note says so on the dashboard, above the full numbers table, in the
  guide and in the Excel file.
* The breakdown has been removed. Each agent now shows **Old cases: received · updated** and **New cases: received ·
  updated**. The full table has the columns Old cases (Received, Updated), New cases (Received, Updated),
  Productivity (old updated + new updated), Update rate, and the due reminder columns.
* **Unassigned** rows (no region, or the name "Unassigned") are not shown.
* **Scorecard, rated 1 to 5.** Each KPI is rated with the score table below. The overall score is the weighted average of
  the ratings, from 1.00 to 5.00. Exceeds 4.50+, On track 3.50–4.49, Watch 2.50–3.49, Below target under 2.50.

  | KPI | Weight | 5 (highest) | 4 | 3 | 2 | 1 (lowest) |
  |---|---|---|---|---|---|---|
  | Follow-through | 30% | 90%+ | 80–89% | 70–79% | 50–69% | under 50% |
  | Due misses per case | 25% | ≤0.05 | 0.06–0.15 | 0.16–0.25 | 0.26–0.40 | over 0.40 |
  | Time to acknowledge | 10% | ≤30 min | 31–60 min | 1–2 h | 2–4 h | over 4 h |
  | Productivity per active day vs region average | 25% | 100%+ | 85–99% | 70–84% | 55–69% | under 55% |
  | Reminders left unacknowledged | 10% | 0 | 1 | 2 | 3–4 | 5+ |

  A KPI with no value for the agent (for example no due reminders, so no time to acknowledge and nothing open) is left
  out, and its weight is shared equally by the other KPIs. An agent with no data in the period shows "No data" with no
  score. With fewer than 8 cases, the ratings are shown but there is no overall score. The Excel file has the Scorecard
  and Score table sheets.
* **Same person, two names** (Settings → Profiles, managers and Vendor Management only): choose the name typed another
  way and the name on the schedule to keep, then click **Merge**. Productivity, scorecard, due misses, case history and
  region are then counted under the kept name. Merges are saved in `config/aliases`, so no code change or script is
  needed. ✕ undoes a merge (after a refresh).

## Monthly shift schedule, attendance and Absent (Nov 17, later)

* **Monthly schedule.** Settings → Shift Schedule shows a whole month (‹ month ›). Each person has one value per day: a
  shift time, OFF, PTO or **Absent**. Values are saved by date (`msch` on each person in the staff list; about 13 months
  are kept). A day without a monthly value falls back to the weekly pattern (shown faded).
  * **Template** downloads the monthly layout for the month shown: names in column A, the dates across row 3
    (YYYY-MM-DD) and weekdays in row 4. `templates/PET_Shift_Schedule_Template.xlsx` and the built-in copy use the same
    layout.
  * **Upload** reads that layout, keeps earlier months, and sets the weekly fallback from the month. The old 7-day
    layout still uploads as the weekly pattern.
  * **Export current** writes the month shown in the same layout.
* **Region backtracking:** the region an agent had in a month comes from that month's schedule. The productivity report
  and scorecard use the region the agent worked in during the selected period (still one row per agent).
* **Log-in time and attendance:** the first time an agent is signed in to PAT for a shift (from 2 h before its start) is
  saved in `att/<name>_<date>`. Agents who stay signed in are recorded when the shift window starts.
  * **Absent:** an agent on shift with no log-in yet shows as Absent (Agent Status and Shift Schedule) and gets **no
    cases** (round robin, hand-over, balancing) until they log in.
  * Logging in clears Absent at once; it counts as **Late** if the log-in is more than 5 minutes after the start.
  * No log-in before EOS: the screen that runs the hand-over marks the day Absent automatically.
  * Attendance is counted from the day this version first runs (`config/att.since`).
* **Reports:** the productivity report shows attendance per agent, in the full table (scheduled shifts, present, late,
  absent, attendance %) and as a list (🕘 Attendance). The Excel file has an Attendance sheet.
* **Scorecard:** Attendance is a KPI (15%). 100% = 5, 95–99% = 4, 90–94% = 3, 80–89% = 2, under 80% = 1. The weights
  are now Follow-through 25%, Due misses 20%, Time to acknowledge 10%, Productivity 20%, Unacknowledged reminders 10%,
  Attendance 15%. A KPI with no value still shares its weight with the others.

## Region by date, first-month attendance, speed (Nov 17, later)

* **Region by date:** each case counts in the region the agent was in on the day they received it (received counts) or
  updated it (productivity). The region comes from that day's shift on the monthly schedule (`regionOn`). Due misses
  use the due date, and attendance uses the shift date. An agent whose region changed in the period appears in each
  region with the counts for those days. Without a change, the agent has one row as before.
* **First month of attendance** (the month tracking started in, from `config/att.since`): every scheduled shift counts
  as present (100%), except days marked **Absent** on the schedule. Automatic Absent marks are not counted or shown for
  that month. From the next month on, attendance comes from the log-in times. The live rule "not logged in by shift
  start = no cases" still applies.
* **Speed:**
  * The productivity and scorecard numbers are worked out once per data version and reused across views, dates and the
    trend (`PD_CACHE`).
  * Every case is read once into an index (credits, update days, closes, due reminders), and each period only filters it.
  * The per-day chart comes from the same pass instead of one recount per day.
  * Name and person lookups are memoised.
  * Agent Status day counts are computed once per redraw.

  Measured with 1,500 cases and 60,000 history entries: opening the productivity view went from 0.59 s to 0.10 s
  (0.05 s when reopened), the scorecard from 0.21 s to 0.01 s, and a full screen redraw from 36 ms to 16 ms.

## One row per agent, earlier region compared separately (Nov 17, later)

* A schedule or region change no longer splits an agent. Each agent is **one row in their current region** (monthly
  schedule), in the dashboard, full numbers, scorecard and Excel file.
* The days an agent worked in an earlier region during the period are kept apart (`segs`). In the scorecard,
  productivity per active day is compared with a benchmark that mixes the region averages, weighted by the agent's days
  in each region. Earlier days are compared with the earlier region, and current days with the current region.
* The tables and scorecard cards show this as "· earlier EMEA 3 days". The productivity result on the card says which
  regions the average mixes.

## Follow-through, store number, quiet alerts, coordinator on duty, steadier screen (Nov 17, evening)

* **Follow-through = total productivity ÷ total cases received**, in Agent productivity & due misses (dashboard, trend,
  full table, Excel) and in the scorecard. It can go over 100% when cases are updated on several days.
* **Store number:** a required field beside Account name in the case details (needed to close the case, logged in
  Case History). In the Weekly report, the Account Name column shows the store number, or the account name when no
  store number is set yet.
* **Quiet alerts** (Settings → Profiles, managers and Vendor Management): the people on this list get no reminder alarms
  and no alert or mention pop-ups; announcements still pop up. It starts with Joerolyn Franquelli and Jose Teves and is
  saved in `config/quiet`.
* **Coordinator on duty** (Agent Status, managers and coordinators choose; saved in `config/cod` with the history):
  * The coordinator on duty gets every pop-up and alert, shows the aux "Coordinator on duty", and gets no cases.
  * Coordinators not on duty get alerts for their own cases and mentions only. With nobody on duty, coordinators get
    everything, as before.
  * Time on duty is left out of productivity: updates made and cases received while on duty do not count.
* **Steadier screen:**
  * A case saved with a missing or odd field (no owner, items not a list, a null item, ...) could stop the whole screen
    from drawing. Every case is now tidied when it is read, and if a redraw ever fails it tidies the data and draws again.
  * The Streamlit frame height is now kept up to date (it was set once), so the app keeps filling the window.

## Blank Account Name without a store number; no lost typing on a white flash (Nov 17, night)

* **Weekly report:** the Account Name column shows the store number and stays blank when the case has none.
* **White screen:** Streamlit rebuilds the app's frame (a white flash that loses unsaved typing) when something appears
  above it or the server run fails. To stop that from happening:
  * The connection spinner and the database error no longer appear above the app; the error sits in a fixed slot.
  * The server always draws the app's frame, even if handling a request fails.
* **If the frame reloads anyway** (for example a network drop or a server restart), the case that was open and what was
  being typed (case details, Add Case) are kept in the browser (`pat_draft`, up to 2 hours). They are put back after the
  reload, with the note "Restored what you were typing", and fields that save on change are saved.

## Monthly filter by default; productivity top rating at 100% (Nov 17, night)

* **Monthly filter:** Agent productivity & due misses, the Scorecard and My productivity open on **this month** (the
  1st to today). The filter bar has a **Month** picker and **This month** / **Last month** buttons. An earlier month
  covers the whole month. Dates can still be set by hand.
* **Scorecard, productivity per active day vs the region average:** 100% or more = 5 (highest), 85–99% = 4,
  70–84% = 3, 55–69% = 2, under 55% = 1.

## Fix: the schedule reverting and the app refreshing (Nov 17, late)

What went wrong:
* **Status saves rewrote the whole staff list.** A status change (the automatic EOS aux, Available / aux, idle
  sign-in, coordinator on duty) wrote the whole staff list, including the shift schedule, from that screen's copy.
* **Computer clocks decided which copy won.** A screen ignored a newer schedule if its own last save had a later time on
  its computer's clock, so a screen with a clock a few minutes ahead kept the old schedule and kept writing it back.
  The screen that runs the hand-over was also chosen by computer clocks, so two screens could both run it and write in
  turn: the constant refreshing.
* **Reloads replayed old saves.** After a reload, settings saves left over from the previous page (up to 10 minutes
  old) were sent again.

Fixes:
* **Status saves:** `saveStatus` writes only the status fields onto the newest saved staff list (`STAFF_DOC`), so a
  status change can never put back an older schedule. Only schedule edits by a manager or coordinator write the schedule.
* **Accepting newer copies:** a newer staff list from another screen is always taken (no clock comparison). The
  automatic region-history save runs at most every 10 minutes per screen.
* **Server clock:** every screen uses the server's clock (`srvNow`, sent with every reply) for the hand-over lease and
  for save times.
* **No replays of settings:** settings saves (`config`, seats, sign-in marks) are never replayed after a reload. Other
  saves are replayed for 2 minutes only.
* **Frame height:** it is no longer recalculated on a timer (scrolling could change it and move the page). It is
  worked out at start and on resize, and the same height is re-sent every 30 s.

The schedule that was overwritten must be uploaded again once, after this update is live.

## Fix + new: zeros after a reload, database notices, COD aux, transfer several cases (Nov 18)

- **No more counters dropping to 0.** The page keeps the last data it saw in the browser. When it reloads (Streamlit
  reconnecting, a refresh), that copy is shown straight away and replaced by the server's copy as soon as it arrives.
  While only the kept copy is shown, no screen moves cases on its own and staff/status saves wait for the server's
  copy, so an older schedule is never written back. Counters show "…" while the first data is still loading.
- **Fewer "disconnected" notices.** A MongoDB hiccup shorter than 8 seconds (`DOWN_GRACE`) is retried quietly and not
  reported. The "Reconnecting" badge appears only when the problem lasts more than about 6 seconds. The connection pool
  is larger (50, wait up to 20 s). Large collections are no longer sent along with every answer (over 1.5 MB per
  collection, or 3 MB in total); the browser fetches them the normal way, so slow connections stop dropping.
- **The coordinator on duty is set to Unavailable · COD automatically.** That stops every screen from giving them
  cases, including screens still running older code. They can't switch themselves back to Available. When the duty
  ends (or moves to someone else) they go back to Available.
- **⇄ Transfer cases** (next to Add Case): tick several open cases (search and "Select all shown" help), pick a person
  or "Next available agent", then Transfer. Managers and coordinators see all open cases; agents see only their own.
  Closed cases never move. Each move is logged as "Transferred by … (several cases)".
- Tests: `tests/shim_boot_cache.js` (new), Nov 18 block in `tests/feature_checks.js`, grace period and push cap in
  `tests/test_reconnect.py`.

## Fix: background refreshes never disturb typing; everything typed is saved (Nov 18, later)

- **Refreshes stay in the background.** The dashboard redraws every second, and the open case and Settings redraw when
  another screen saves. Those redraws now keep whatever is being typed: the text, the cursor position and the focus stay
  as they were (`withKeep` around `render`, `renderCase` and `setTabTo`). A field is only reset after the person submits
  it (Enter, or a button).
- **Conflicts found and fixed.** The 1-second timer, the case-change listener and the Settings listeners each redrew
  the screen on their own rules, and some of them threw away fields that were being typed in. All of them now go
  through the same keep-what-is-typed step.
- Test: `tests/typing_keep.js` (real browser).

## Case details save exactly as before (Nov 18, latest)

- The original saving behaviour of the case details is back, unchanged:
  - a case field saves when you leave it;
  - checklist items, work/part orders, the maintenance window and the revisit save with their buttons (Add, Set, Save…).
- Removed: the 2-second autosave while typing, saving on tab leave, and the save-on-close of unfinished entries
  (Nov 18), including their `dft` case field.
- Kept: background redraws don't wipe what is being typed, and the draft keeper (Nov 17) still puts back typing after a
  page reload.
- Fixed: an open case no longer keeps showing an old value after a save from another screen, or after the page's
  kept copy is replaced by the server's. Only fields being typed in are kept over a redraw.
- The browser's kept copy is refreshed every 4 seconds (was 15) after a change, so it is closer to the latest saves.
- Test: `tests/typing_keep.js` updated; `tests/autosave_close.js` removed.

## Nothing typed in a case is lost; saving happens in the background (Nov 18, 01:20)

- **Case fields save while you type.** Store number, model number, RITM, case number and SFDC IDs are saved quietly
  half a second after the last key. The history line ("Model number updated") is still written once, when the field is
  left, as before. Account, status and severity lists save when picked, as before.
- **Closing a case by accident, or opening another case from an alert, keeps what was typed.** Entries still waiting
  for their button (new checklist item, work/part order Task ID/label, maintenance window dates, revisit) are kept with
  the case (case field `dft`, saved in the database). They are shown again when the case is opened, on any screen.
  Nothing is added until its button is pressed, and once it is, that kept entry is cleared. All buttons are unchanged.
- **Nothing visible.** No message, redraw or waiting while saving. The "Reconnecting" badge appears only if a
  database outage lasts more than 45 seconds. Unsaved changes are kept and sent automatically meanwhile.
- Tests: `tests/keep_on_close.js` (new, real browser) and `tests/typing_keep.js` (updated).

## Fix: the coordinator on duty is always Unavailable · COD (Nov 18, 02:00)

- Before, the aux changed only at the moment someone picked the coordinator on duty on an updated screen. A duty set
  earlier, or a status changed by an older screen, stayed Available.
- Now `codEnforce()` keeps it right. The screen that runs the hand-overs checks every second, and the coordinator's own
  screen every 5 seconds:
  - the coordinator on duty is set to Unavailable · COD;
  - anyone left on aux COD who is no longer on duty goes back to Available.
- It waits until the schedule and the duty are loaded from the database, so it never acts on half-loaded data.

## Store number: N/A or type it; Weekly report uses the account name for N/A (Nov 18, 02:15)

- In case details, Store number is now a list:
  - **N/A** saves "N/A". It counts as filled, so the case can be closed.
  - **Type store number** shows a box under the list to type the number. The number saves as before, quietly while
    typing, with the history line written when the box is left.
  - Switching from N/A to Type clears the N/A.
- Weekly report (screen and Excel), Account Name column:
  - shows the store number when there is one;
  - shows the account name entered in the case when the store number is N/A;
  - stays blank when nothing is set.

## Faster opening (Nov 18, 02:35)

- **The data sent with the page is ready in memory.** A background thread on the server refreshes it every 3 seconds
  while the app is in use (`WARM_EVERY`, `WARM_IDLE`). Opening the app no longer waits for every collection to be read
  from MongoDB.
- **Only what changed is read again.** Each collection is cached by its own change counter and changed ones are read in
  parallel. Before, any single change made the next page open re-read all collections one after another.
- **Attendance is no longer sent with the page.** The page always reads it from the server with a date filter, so the
  copy was never used (`NO_MIRROR`). It is also no longer pushed to every browser on each sign-in.
- **The font no longer holds up the first screen.** The Google font loads in the background.
- With the kept copy from earlier tonight, a browser that has opened the app before shows the last data immediately,
  then the live data.
- Local measurement with 1,500 cases, 3,000 history lines and 4,000 attendance records: cases on screen in 0.5–0.8 s
  after the page arrives. On Streamlit Cloud, an app that has gone to sleep still needs its wake-up time first; that
  part can't be changed from the app.
- Test: `tests/test_mongo_cache.py` (only changed collections re-read; attendance not sent).

## Keep-awake (Nov 18, 08:45)

- `.github/workflows/keep_awake.yml` runs every 3 hours, and from the Actions tab with "Run workflow".
- It runs `tools/keep_awake.py`, which opens the app in a headless browser.
  - A plain web request (curl/ping) no longer wakes a Streamlit Cloud app: a sleeping app shows "This app has gone to
    sleep" and its "Yes, get this app back up!" button has to be clicked in a browser. The script clicks it, waits
    until the app has loaded, and tries three times before reporting a failure.
- Setup: add a repository secret `APP_URL` (Settings → Secrets and variables → Actions) with the app's address, e.g.
  `https://your-app.streamlit.app`.
- GitHub turns scheduled workflows off after 60 days without commits to the repository. If that happens, re-enable the
  workflow on the Actions tab.

## Fix: ownership history and scorecard timing; tick boxes in the case list (Nov 18, 10:30)

- **"Received" time of a case.** A case that had not been handed over yet used its last-update time as the time its
  first owner received it. So its "received" day moved every time the case was updated, and the first entry of the
  ownership history (written at the first hand-over) carried that wrong time. Now it is the earliest known time of the
  case: its first history line, or any recorded hand-over (`caseStart`, `credOf`, `ownTimeline`). Cases already
  stored are read correctly too; nothing has to be changed in the database.
- **Due reminders after end of shift.** When an agent reaches EOS and nobody is available, their cases stay with them
  until the first agent comes online (the hand-over runs in the open PAT screens). A reminder that fell due in that
  gap used to count as a due miss for the agent who had already gone home.
  - Now it counts for the agent who received the case next, timed from when they received it.
  - If the departed owner acknowledged it first, it stays with them.
  - The Due reminders table explains it: "Due after X's end of shift: counted for Y from when they received the case".
- **Clearer history line.** A hand-over made long after EOS now reads: "X reached end of shift (EOS) at <date, time>;
  nobody was available then: case handed over to Y, the first agent available".
- **Tick boxes beside each case.** "⇄ Transfer cases" now puts a tick box at the start of every open case row in the
  PET Cases list (agents: their own cases).
  - A blue bar above the list shows how many are selected, with "Select all on this page", Clear, "Transfer to" and
    Transfer.
  - Ticking a box does not open the case.
  - "✕ Done selecting" removes the tick boxes. The separate pop-up list is gone.

## Fix: every action is saved and counted in productivity, due misses and the scorecard (Nov 18, 11:45)

- **History lines and attendance are never dropped.** Case history lines (`act`) and attendance records (`att`) that
  could not be saved right away (connection or database trouble) used to be thrown away: after 15 minutes without a
  connection, or 2 minutes after a page reload.
  - They now stay in the browser's outbox and are sent as soon as the database answers.
  - The browser retries every minute and keeps them for up to 7 days.
  - Each is its own record, so sending one late cannot overwrite anything newer.
  - Settings and case saves keep the earlier rules.
- **Reports read the whole period.** The Agent productivity & due misses table, the scorecard, the agent profile and
  the Excel export now read every history entry of the period from the database, one day at a time. One query used to
  stop at 20,000 entries, so a busy month lost entries at random.
  - The scorecard and the Excel export also wait for that data now. Before, only the productivity table loaded it.
- **Older cases are included.** A screen keeps only the 1,000 newest cases. Cases outside those that were worked on in
  the period are now read from the database for the reports. Their updates, received cases and due misses count;
  before, they were left out.
- **Every hand-over gets its history line.** A second automatic hand-over between the same two people on the same day
  was taken for a repeat and not logged. Now each one is logged.
- Nothing else changed.

## Fix: saves without delay, no white-screen hiccup (Nov 18, 16:00)

- **Cause.** The page sent everything it was waiting for in one message to the server. Since 11:45 the reports read a
  whole month of history (and older cases) that way, which made one very large answer. Saves waited behind it (the
  delay), and an answer that big could choke the page (the white screen).
- **Saves first, small messages.** Every message now carries all waiting saves first, then at most 2 list reads and 25
  single reads. The rest follow in the next messages, so a save is never stuck behind a big read.
- **Fewer, smaller report reads.** The period's history is read a week per query instead of a day per query. A week
  that reaches the 20,000-entry cap is read again day by day, so nothing is cut off.
- **Faster typing saves.** Case fields save 0.3 s after the last key (was 0.5 s).
- **Less work in the browser.** The kept copy of the data is written to browser storage every 20 s (was 4 s) and when
  the tab is hidden or closed. Writing it is heavy and could make the page stutter.
- Test: `tests/shim_batching.js` (new).

## Quiet background work; more entries saved in real time (Nov 18, 16:20)

- **No loading or connection notices for short trouble.** Reconnecting, a slow first answer and a passing storage
  error are handled in the background. The small notice at the bottom left appears only if the trouble lasts more
  than a minute. The "MongoDB not connected" warning (a setup problem: nothing is saved) still shows after 6 seconds.
- **No loading sign in the counters.** While the very first data arrives, the counters stay empty instead of showing
  "…". A browser that has opened the app before shows its kept copy straight away.
- **More entries saved while typing.** These save quietly 0.4 s after the last key; the history line or the "Note
  saved" message still comes once, when the box is left, as before:
  - editing a checklist item's text;
  - the scorecard context note.
- Already saved while typing, unchanged:
  - case fields (store, model, RITM, case number, SFDC IDs);
  - entries waiting for their button (new checklist item, work/part order, maintenance window dates, revisit), kept
    with the case.

## Fix: entries save as you type, no waiting (Nov 18, 17:30)

- **Saved on every key.** Case fields (store, model, RITM, case number, SFDC IDs), checklist item edits and the
  scorecard note are handed to the save on every key; there is no pause timer any more. Entries waiting for their
  button are kept with the case 0.15 s after a key (was 0.4 s).
- **No waiting for a pause.** A case is saved within 0.25 s of a change, even while typing continues. Before, each key
  restarted the timer, so nothing was saved until the typing stopped.
- **Saves never wait behind reads.** A message that carries saves now carries only the saves, so its answer comes
  straight back.
- **No flicker back to an older value.** While a save of a case is waiting or on its way, copies of that case coming
  from the server are held back until every save is done.
- Local two-screen check: the second screen showed a store number about 0.2 s after the last key.

## Fix: the app resetting to older data and closing the open case (Nov 18, 18:40)

- **Cause found: server memory.** The server kept read results in memory. Results of an older version stayed until 400
  had piled up, and very large results (a week of history for a report, up to 20,000 entries each) were kept too.
  With several people opening reports, the app's memory filled up and Streamlit Cloud restarted the app. Every open
  page then reloaded, showed its older kept copy, closed the case being worked on, and the live data came back only
  when the app was up again, minutes later.
  - Results with more than 3,000 entries are no longer kept (`READ_CACHE_DOCS`).
  - An older version of a collection is dropped as soon as a newer one is read.
  - At most 200 results are kept (was 400).
  - The size check for pushing data to the browsers now uses a small sample instead of converting a whole collection
    to text on every change, which also used a lot of memory and processor time.
- **Smaller report reads.** Reports read the period's history one day per query again. The page sends them 2 at a
  time, so each answer stays small for the server and for the page.
- **The open case comes back.** If the page reloads for any reason, the case that was open reopens by itself once the
  data is there (if it was open in the last 15 minutes and not closed by the user). Its typed entries are kept, as
  before.
- Tests: `tests/test_mongo_cache.py` (memory stays bounded) and `tests/reopen_after_reload.js` (new, run like
  `live_browser.js`).

## Download all data in one click (Nov 18, 20:00)

- Reports → **⬇ Download all data (Excel)** (managers and coordinators) downloads `PAT_All_Data_<date>.xlsx`.
- **Summary** sheet: when and by whom it was downloaded, and each sheet with its number of records.
- **One sheet per collection**, every record and every field:
  - cases, act (case history), att (attendance), config (settings), ann, mentions, acks, seat, avail, acct, seen;
  - a **Shift schedule (staff)** sheet, one row per person.
- **Formatting:**
  - green header row, frozen, with filters;
  - borders and banded rows;
  - columns sized to their content;
  - times as real dates (yyyy-mm-dd hh:mm, local time);
  - nested values (checklist items, ownership history…) as readable text.
- **Nothing is cut off.** Big collections are read a month at a time (a day at a time if a month is very large).
- Each download is logged ("All data downloaded").

## Nov 19 (01:45): Excel download, CSR only, COD approval, passwords, smoother reloads, clear cache

- **Agent productivity & due misses Excel.**
  - The download waited for every read of the period (up to 50 round trips), which could take very long; it now waits
    at most 20 s for that data.
  - A graph that cannot be drawn within 6 s is left out instead of holding the file.
  - Every cell is now a clean text, number or date (`xv`). A "not a number" or a raw object made Excel repair the file
    on opening and drop its formatting.
  - The page may now send 4 small list reads per message (was 2), so report data arrives faster.
- **CSR only.**
  - Add Case has a "🧾 CSR only" tick box (case field `csr`).
  - A CSR only case has no CE arrival time, maintenance window, Lift / Cabling/HOD tick boxes or revisit, and those
    are not asked for when closing.
  - Its statuses are Ordered, Escalated, Shipped and Delivered, and the case shows a "CSR only" tag.
- **Manual transfers need the coordinator on duty's approval.**
  - A transfer made by hand (Transfer, Next available, or several ticked cases) becomes a request kept with the case
    (field `xreq`). The case shows "⏳ Waiting for approval", and the person who asked can cancel it.
  - The coordinator on duty gets a notice (bottom right, with a sound) listing each request with Approve, Reject and
    Open case.
  - Approved: the case moves to the person asked for (or the next available agent).
  - Rejected: it stays where it was.
  - Both are written in the case history, and the person who asked gets a message.
  - Without a coordinator on duty, or when the coordinator on duty transfers, it happens at once as before. Automatic
    hand-overs and balancing are unchanged.
- **Clear password works.** Every browser used to merge its own older copy of the passwords back in and save it again,
  so a cleared password came back a few seconds later. The database copy now decides; this browser's copy is used
  only right after a change made here, or when the database has none yet.
- **Realtime saving: old conflicting code removed.** The Nov 17 draft keeper still put back case details typed before
  a reload and saved them again, which could overwrite newer values and log them twice. Case details now save while
  typing, so the draft keeper is limited to the Add Case form. Unfinished case entries are kept with the case in the
  database (Nov 18).
- **Reloads no longer show tiles without cases.**
  - The copy of the data kept in the browser moved from localStorage to IndexedDB. localStorage holds only about 5 MB
    of text, so with many cases the copy was too big and dropped.
  - After a reload the dashboard and cases show at once from this copy, while the live data loads in the background.
  - The app's frame now shows the app's background colour while loading, instead of a white flash.
- **Settings → Timezone and Data → "🧹 Clear cache and reload".** It clears this browser's kept copy of the data and
  other copies of database data, then reloads. It never removes saved data: cases, the history of every action,
  attendance and settings are in the database. Unsent changes (outbox), the Add Case draft, the sign-in and the theme
  stay.
- **Outdated code removed** (never used anywhere): `applySnd`, `bulkList`, `nextId`, `saveAruba`. Functionality is
  unchanged.

## Nov 19 (02:30): no interruptions while typing; leaner server

- **The open case no longer refreshes while someone types in it.** Every save made while typing came back from the
  database a moment later. That echo, and each new history line, redrew the whole case under the person typing, so it
  looked as if the case reloaded and a key could be lost. These updates now wait while the cursor is in a case field
  and are shown as soon as the field is left (`caseRedraw`). Saving while typing is unchanged.
- **Leaner server.**
  - Removed the background thread added on Nov 18 that re-read the data every 3 seconds.
  - Removed the extra threads used to read collections in parallel. Unchanged collections still come from memory.
  - Removed the "last use" tracking that only that thread needed.
  - Less memory and processor work means fewer reasons for Streamlit Cloud to restart the app.
- Nothing else changed.
- About page reloads: Streamlit Cloud restarts the app, and every open page reloads, each time new files are pushed to
  GitHub and when the app runs out of memory. Pushing updates outside working hours avoids the first.

## Fix: a cleared profile password stays cleared (Nov 19, 08:20)

- Clearing a password now keeps an empty entry for that profile in `config/profileHashes`, instead of deleting it.
  - Screens still running an older version merge their own saved copy into the database copy and save the result.
    With the entry deleted, their old password filled the gap and came back minutes later.
  - An empty entry in the database now wins over their copy, so nothing is saved back.
- When two copies of the same profile meet, the cleared one wins (`normalizeProfileHashes`).
- Setting a new password later works as before. Only the password section changed.

## New log-in picture (Nov 19, 09:00)

- The log-in page uses the new team picture: web 1672×941 and mobile 937×1678 (both WebP, inside `web/pet_station.html`).
- Every face keeps its seat id, so claimed faces stay claimed and every profile is unchanged. Only the face areas were
  re-measured for the new pictures (`SEAT_GEO_B`, `LP_B`).
- New face `d1`: **Maricar Dela Cruz**, front row in the green blazer, next to Jeff Bote.
  - Role "Director", with the same access as the managers (`MGR_SEATS_B`, `MGR_ROLES`).
  - Like the managers she is not part of the shift schedule and gets no cases (`isMgr` also recognizes "Director").

## Nov 19 (21:00): canceled cases, weekly maintenance window, first log-in, due misses

- **Canceled cases.** The maintenance window is optional when closing a case with status Canceled (`missingFields`).
- **Weekly report.** The Maintenance Window column shows only the current window ("start to end"), without the
  Original / Update / Window tags (`mwX`). The case details still show the full history of the window.
- **Attendance log-in time.** Only the first log-in of the shift day is recorded.
  - The record used to be written again whenever the attendance list had not finished loading (right after a reload,
    or on a second computer), so a later time replaced the first one.
  - Now it waits for the list and checks the saved record in the database before writing.
  - Example: a 10 PM shift, first log-in at 10 PM → the log-in time stays 10 PM.
- **Due misses.**
  - A miss counts for whoever owned the case when the reminder fell due, compared against when it was acknowledged.
  - The Nov 18 rule that moved such misses to the next owner is removed; it counted misses for people who did not
    have the case then.
  - Who owned the case when now comes from the ownership history saved with the case and also every "Ownership
    transferred" line in the case history (`ownTimeline`). The saved list could miss hand-overs made by other or
    older screens.
- Only these parts changed.

## Clean-up: outdated code removed (Nov 20)

Removed (not used anywhere; nothing changes for users):

- **Old log-in picture side strips** (`.lext`): two image strips cut from the edges of the previous log-in picture, plus
  their styles. They had been hidden for good (`display:none!important`) since the picture is extended to the screen
  edges another way (`.lx`). About 19 KB.
- **Styles for elements that no longer exist:**
  - `#tabs` (old tab bar);
  - `.s-arm2` (second Santa arm);
  - `.sl-elf` (elf in the sleigh);
  - `.ssn-pushed` / `.ssn-pushed-r` with `@keyframes tilePush` / `tilePushR` (old naughty-list tile push, replaced by
    `.ssn-bump`).
- **Unused JavaScript:**
  - `relevant()` (old case filter);
  - `isOn()` (old on-shift check, replaced by `onShiftAt`);
  - `DEF` (empty demo list);
  - `NONOTE` (old note switch);
  - `RT_T` (timer of the old save delay);
  - `pct()` (unused percent helper in the productivity table).
- Removed earlier: `applySnd`, `bulkList`, `nextId`, `saveAruba` (Nov 19); the background data thread (Nov 19);
  the Transfer cases pop-up list (Nov 18).

Still in place, listed for review (each one works and is in use or kept on purpose):

| Item | What it is | Note |
|---|---|---|
| `prodCredsOf`, `regionFor`, `sSet`, `setUser` | small helpers | used only by the automated tests |
| Old text copy reader in `web/shim.js` (`pet_boot_cache`) | reads the kept copy saved before Nov 19 | can go once every browser has opened the Nov 19 version |
| Seasonal decorations (Christmas, New Year, Valentine's, Halloween; Santa, naughty list) | shown by date, can be turned off in Settings | feature |
| DIY log-in picture editor | upload a picture and mark faces (Settings) | feature; not needed if only the built-in picture is used |
| Local storage (`MemStore`) in `streamlit_app.py` | used when MongoDB is not set up, and by the tests | keep |
| `tools/keep_awake.py`, `.github/workflows/keep_awake.yml` | keep-awake | only if that GitHub workflow is used |
| `Dockerfile`, `.env.example` | running PAT outside Streamlit Cloud | optional |
| This README's change history | notes for every update | can be shortened |

## Fix: after a reload the dashboard showed an old sample schedule (e.g. only "Lucille Layug") (Nov 20, 12:10)

- **Cause.** The page starts with a built-in sample schedule (the old demo list, which includes Lucille Layug). With
  the database on, that list was used until the real schedule arrived:
  - **Shown:** after a reload or a crash, the dashboard showed the sample agents for a moment.
  - **Saved:** a status save in that moment (aux, available, sign-in) built the schedule from the sample list and
    wrote it to the database.
  - **Saved:** if the schedule document did not come back on one answer, a manager's screen saved the sample list
    as the schedule. Every screen then showed the old data until someone fixed it.
- **Fix.**
  - With the database on, the page starts with no sample agents (only the manager profiles) and waits for the real
    schedule.
  - The sample entries are tagged (`demo`). A schedule containing them is never saved (`hasDemo`).
  - A status save before the real schedule has arrived does nothing.
  - The automatic "save the schedule when none exists" is removed; a manager adds or uploads the schedule instead.
  - The local demo mode (no database) still uses the sample list.
- Tests: the test databases now start with a schedule put in by the test itself.

## Fix: the app suddenly going white and reloading (Nov 20, 12:25)

- **Cause.** Streamlit keeps the app's frame only while every run of the server script draws it. If a run fails
  before or while drawing it, Streamlit shows an error box in its place (hidden on this page, so the screen turns
  white). The next good run draws a new frame, which is a full reload, and the page then showed its older kept copy
  until live data arrived. Three things could make a run fail:
  - **Values that are not valid JSON.** A date object or a "not a number" in a stored document could not be handed
    to the frame, so drawing it failed.
  - **The sidebar or the storage status check.** If either raised an error, the run stopped before reaching the frame.
  - **Any other error while drawing.**
- **Fix** (`streamlit_app.py` only):
  - Every answer handed to the frame is checked and, if needed, cleaned into valid JSON first (`json_safe`). Valid
    answers pass through untouched.
  - If drawing the frame still fails, it is drawn again at once with a plain answer, so the frame is never replaced.
    The page then simply asks again.
  - The sidebar and the storage status check can no longer stop the run before the frame is drawn.
- Restarts of the app by Streamlit Cloud (a push to GitHub, running out of memory) still reload every open page. The
  open case comes back and typed entries are kept (Nov 18–19).
- Test: `tests/test_frame.py` (new).

## Nov 22: clean-up, realtime saving only, every Case History entry kept (with the IM•LOGIC bridge)
Built on the version with the IM•LOGIC ⇄ PET message thread (`im_pet_bridge.py`, see `IM_LOGIC_BRIDGE.md`). Nothing was
removed from what users can do.
* **Saving is realtime only.** Case entries already save as you type (bundled every 0.25 s). The last change waiting in that
  bundle used to be lost if the page was closed, reloaded or put in the background within 0.25 s; it is now sent at once
  (`flushSaves()` on page hide / close). The draft kept on page close is now really sent too (it waited for the same bundle).
* **Every Case History entry is kept.** A field's history line is written when you leave the field. If the page was closed or
  reloaded while still typing, the value was saved but its history line was not; the field is now finished first, so the
  line is written. IM•LOGIC messages that arrived while PET was closed (up to 7 days back) now also go into the case
  history, with the message's own time and id, so every screen writes the same single entry (it used to take only messages
  from the last 10 minutes).
* **IM•LOGIC thread glitches fixed.** A sent reply or a new IM•LOGIC message did not show while the cursor was in the case
  (the redraw waits until typing stops, and the reply box is in the case). The thread now updates in place, without redrawing
  the case. An unsent reply is kept like other unfinished entries (also after a reload). On the server, the message checks
  use database indexes (they stay quick as the thread grows) and fail fast while MongoDB is unreachable, so they can never
  hold up the page.
* **Removed (outdated):** the 34 calls to the old general-action loggers that no longer recorded anything (`glog`, `aglog`);
  the reader for the old text copy of the data (replaced by IndexedDB on Nov 19), whose leftover is now cleared from the
  browser storage to free space.
* Tests: `tests/live_bridge_pet_side.js` (PET's side of the IM•LOGIC thread, the other app simulated through the shared test
  file), new checks in `tests/feature_checks.js`, `tests/shim_boot_cache.js` now uses an IndexedDB stand-in.

## Attendance: 24-hour log-in times; late lowers attendance (Nov 23)
* The **Logged in** time in the attendance list (Reports) and its Excel sheet is now in the 24-hour format of the schedule
  (e.g. shift `09:00-18:00`, logged in `09:07`), so a late log-in is easy to see. When the log-in was on another day than
  the shift (early for a night shift), the date is shown before the time.
* **A late log-in now lowers attendance.** A late shift counts only for the part of it the agent was logged in for:
  credit = 1 − minutes late ÷ shift minutes (e.g. 54 min late on a 9-hour shift = 90% for that day). On time (within the
  5-minute grace) = 100%, absent = 0%. The attendance % in the report, the totals row, the scorecard and the Excel export all
  use this. The counts (present / late / absent) are unchanged.
* (Nov 23, 14:30) A **LATE** tag now shows beside a late log-in time in the attendance list (e.g. `09:07 LATE`), and in
  the Excel sheet's "Logged in" column.

## Report builder: running SLA time, last / next action, next action due time (Nov 23)
New columns you can add in **Reports → Report builder** (they also go into the Excel export and saved templates):
* **Running SLA Time (from MW start)**: time since the *current* maintenance window started (the latest updated window, if it
  was changed), up to now, as hours:minutes (e.g. `27:05`). It stops at the closing time once the case is closed
  (`26:05 (stopped at closing)`). `Not started` while the window is still ahead; empty when no window is set.
* **Last Action**: the checklist task acknowledged last, with when and by whom.
* **Next Action**: the checklist task with the reminder currently set (the earliest one not yet acknowledged); empty once closed.
* **Next Action Due Time**: that task's reminder time.

## Fix: agents logged in but shown Absent with no log-in time (Nov 23, 20:30)
The log-in was recorded only at the moment of signing in. It was missed when the attendance list had not loaded yet at that
moment (common right after opening the page), when the agent was already signed in from before (page reopened or reloaded
with the saved sign-in, or signed in for the previous day), or when they signed in more than 2 hours before the shift.
Now it is also checked when the attendance list arrives and every 20 s while an agent is signed in. The time recorded is
when the agent was first signed in on the page for that shift (not the time of the check), so lateness is right, and a write
that did not get through is retried with that same time. The first log-in of the day is still never replaced by a later one.
Days already shown Absent for agents who are signed in now get their log-in recorded as soon as they open PAT.

## Hand-over queue, faster opening, last / next action from the checklist (Nov 24)
**Hand-over queue (replaces the EOS split and agent-to-agent balancing)**
* At EOS every open case of the leaving agent goes to the **Hand-over Queue** (shown as the owner, and as a yellow line
  above the cases: how many are waiting, how many are high priority and past due). A hand-over requested by hand before
  EOS ("Hand over my open cases") goes to the queue too.
* Each available agent (on shift, Available, logged in, not within 30 min of their own EOS) gets **5 cases** from the
  queue, and **another 5 every hour** after their last batch. An agent who becomes available gets their 5 straight away.
* Order: **high priority** first, then cases whose reminder is **already past due** (most overdue first), then the
  **nearest due**, then the rest (oldest first). One round's cases are dealt one by one to the agents with the fewest, so
  urgent cases are spread out. The agent who sent a case to the queue does not get it back in that
  same shift; from their next shift on they can receive it again (updated 11:40), so a case that stays open for days and
  has been with every agent still always goes out.
* Cases are no longer moved from one agent to another when someone becomes available (that balancing is switched off);
  that agent gets their batch from the queue instead. **New cases (round robin) are unchanged.**
* While a case waits in the queue, a due reminder is not counted as a miss for any agent. Case History shows the move to
  the queue and the assignment from it. Productivity is unchanged (the agent who receives and updates it gets the credit).

**Faster opening:** the data sent with the first answer when PAT opens is now compressed (about 8–10 times smaller,
e.g. 1.4 MB → 145 KB for 900 cases), so it reaches the browser much sooner. The browser unpacks it; nothing else changes.

**Report builder:** *Next Action* is now the item added **last** to the checklist (any day), *Last Action* the item added
before it (with when and by whom it was added), and *Next Action Due Time* the reminder time of that last item.

Tests: new "Hand-over queue" checks in `tests/feature_checks.js` (the old split/balancing checks are kept by name and reported
as RETIRED), `tests/rules_conflict_check.js` checks the queue rules (at most 5 an hour, never held back while an agent can take
a batch), `tests/test_store.py` reads the compressed first answer.

## Settings: hand-over batch size; report builder: SLA time remaining, account name option (Nov 24, 12:15)
* **Settings → Shift Schedule → Hand-over queue:** the number of cases each available agent gets from the queue every hour
  (default 5, from 1 to 50). Managers and coordinators can change it; it saves as you type and applies on every screen.
* **Report builder – SLA column** (now *SLA Time Remaining (until MW start)*, updated 12:35): the time left from the moment
  the report is extracted until the current maintenance window **starts**, as days and hours:minutes (e.g. `2d 05:30 left`).
  Once the start has passed: `Started 1d 03:05 ago`. A closed case is counted at its closing time (`… (at closing)`). No
  maintenance window: `No maintenance window data`.
* **Report builder – Account Name column shows:** choose *Store number (account name if the store is N/A)* (as before, the
  default) or *The actual account name*. The choice is saved with report templates. The weekly report is unchanged.

## Transfer to the hand-over queue; fix: agents signed in but still Absent (Nov 24, 16:45)
* **Transfer options:** *Hand-over Queue* is now in the case's *Transfer ownership* list and in the list for ticked cases
  ("Transfer to"). The case goes to the queue and out from it like the EOS cases (the agent who sent it does not get it back in
  that same shift). Case History: "Moved to the hand-over queue by …". The coordinator-on-duty approval works as for any
  manual transfer.
* **Attendance fix:** a log-in shown on the agent's own screen was not always saved. When the save did not get through (slow or
  lost connection) the screen still counted it as done and never tried again until a reload, so everyone else saw the agent
  Absent with no log-in time. A log-in now counts as done only once the database has it, and is retried every 20 s with the same
  first time. Second, independent source: every signed-in screen notes in the database every few minutes that it is signed in
  and since when; the hand-over screen records the log-in from that note for an agent on shift who has none, and does not mark
  someone Absent who was signed in during the shift.

## Fix: attendance still not updating; open pages now pick up updates by themselves (Nov 24, 17:30)
* **Why the fixes did not show:** a page left open keeps running the version it was opened with. Agents who keep PAT open
  all day were still running the older code (with the attendance bug) after the update. Now every answer from the server
  carries the version of the page it hands out; a page with an older version **reloads itself quietly** when it is safe:
  in the background, or after 60 s without typing or clicking and with nothing being typed in. Unsaved changes are sent
  first and the open case opens again. (Never more than twice per version: no reload loops.)
* **Accurate log-in time after a reload:** when the page is reopened or reloaded with the saved sign-in, the log-in time is
  the time the agent signed in, if the page was open until a few minutes before (signed in all along); otherwise (the
  page had been closed) it is the time they came back.
* The hand-over screen's backup (sign-in notes) also works for pages still on the older version: it counts from the
  first note of an unbroken run of notes.
* **After this update, every open PAT page must be refreshed once** (pages on the older version cannot reload themselves).
  From then on, updates reach open pages automatically.
* Tests: `tests/live_new_version.js` (quiet reload, never while typing), new checks in `tests/feature_checks.js` and
  `tests/test_frame.py`.

## Agents on a day off never get cases (Nov 24, 18:20)
An agent whose day is **OFF or PTO** on the schedule is not given cases, also not by a manual transfer: the case's
*Transfer ownership* list and the list for ticked cases show them as "(day off)" and they cannot be picked; a transfer (or an
approved transfer request) to them leaves the case where it is, with a note; no automatic move gives them a case either.
A night shift from the day before that is still running counts as on shift.

## Fix: agents logged in but still Absent with a blank log-in (Nov 25)
**Cause found:** every screen kept a live copy of **100 days** of attendance. Each log-in changed it, and every open screen then
downloaded all 100 days again (hundreds of KB, growing every day). On slower connections that download did not finish, so screens
kept showing an old copy (agents Absent, no log-in time), and an agent's own screen did not record the log-in at all until that
download had arrived.
* The live copy now holds only the **last 3 days** (small and quick on every screen). Older days are read once in the background
  (15 s after opening, every 30 min, when Reports or the Shift Schedule is opened, and before the productivity Excel export) for
  reports and the schedule. An older day is never counted Absent just because it has not been read yet.
* The agent's screen records the log-in **at once**, without waiting for any list: it checks the saved record of the shift first
  (the first log-in of the day is still never replaced by a later one), then saves, and retries every 20 s until it is saved.
* The log-in time is when the agent signed in (also after reopening PAT with the saved sign-in, if the page was open until just
  before), so lateness and attendance % are right.
* Test: `tests/live_attendance.js` (an agent signs in / reopens PAT; the manager screen stops showing Absent within seconds, with
  the right log-in time).

## Playful style, faces next to names, tool links by case type (Nov 25)
* **Playful style** (on by default; Settings → Theme → *✨ Playful style*, per screen): rounded tiles and cards, soft shadows,
  little bounces on hover, Nunito / Baloo 2 lettering. Only shapes, shadows, lettering and motion change: every colour still comes
  from the selected colour theme or image skin, and seasonal themes (snow, lights, garlands, Santa…) are untouched. With a
  non-default font chosen in the theme, that font is kept. Motion is off for screens set to reduce motion or with effects off.
* **Faces:** the face each person claimed on the team picture now shows next to their name at the top, and next to the case
  owner in the cases table (initials as before when no face is claimed).
* **Tool links (Settings → 🧰 Tools, managers and coordinators):** each tool has a name, emoji, colour (or the theme colour), the
  **case types** it is used for (Aruba, AT&T, Foundation) and a link with case fields in curly brackets: `{sfdc}` (first HPE Case
  ID), `{arubaNo}`, `{attNo}`, `{ritm}`, `{store}`, `{account}`, `{model}`, `{id}`. Every case of those types shows the tools as
  tiles at the top of the case window, already pointing at that case, opening in a new tab; a tile whose number is still empty is
  greyed out ("needs …"). A *Copy IDs* tile copies the case numbers. Optional "Tool opened" line in Case History. *Test with a
  case* shows the exact links. Saved as you type (config/tools) and on every screen. No tools set up = nothing shown.
* Test host (`tests/live_host.py`) now also serves the login picture, so faces can be checked locally.
* (Nov 25, 14:40) **Playful case window and Settings**, in the style of the tool tiles: soft bubbles in the window headers, section
  headers as rounded pills with the icon in a white bubble, the owner box and top bar as dashed "shelves", checklist items as
  rounded cards (required ones soft yellow, done ones a soft tint of the theme), a striped progress bar, pill-shaped buttons, and
  Settings tabs as pill buttons (the open tab filled with the theme colour) with a little theme-coloured underline under each
  heading. Styling only (one style hook added to checklist rows); colours come from the theme, image skins and seasonal
  decorations are kept, and it switches off with *Playful style* in Settings → Theme.

## Nov 25 (22:50): maintenance window column, sound upload fix, report builder for everyone, time notes, refresh message, stability
* **Cases table:** a *Maintenance Window* column beside *Next Reminder* with the current window's start and end (as entered;
  "not set" when the end is still open). Scroll the table sideways on smaller screens.
* **Alert sound upload fixed:** a sound shared by a manager/coordinator was only loaded the first time an alert needed it, so the
  first alerts (and Preview on other screens) played the built-in tone. Shared sounds now load as soon as the alert settings arrive.
  A sound kept on one device was stored in the browser's small text storage, which audio overflows (lost after closing); it is now
  kept in the browser's file storage. Upload errors are now shown. Limit: 3 MB per sound.
* **Report builder for everyone:** agents get a *🛠 Report builder* tab in Settings (pick columns, download the Excel, use saved
  templates). Saving / removing templates stays with managers and coordinators. Their other reports are unchanged.
* **Notes:** the maintenance window says to enter it in the customer's local time or EST; the checklist says alarms and reminders
  are in Manila time.
* **Refresh message:** when PAT is updated, open pages show a large red message across the top of the screen with a *Refresh now*
  button. Pages no longer reload by themselves (that automatic reload, added Nov 24, interrupted people and looked like a crash).
* **Stability (server memory):** the attendance queries now use whole days, so every screen asks the same question and the server
  keeps one copy of the answer instead of one per screen, and there is now a cap on everything the server keeps in its read cache
  together. Running out of memory makes Streamlit Cloud restart the app, which every open page sees as a crash/reload.
* Tests: `tests/live_sound_upload.js` (new), `tests/live_new_version.js` (now checks the red message and that nothing reloads by
  itself), new checks in `tests/feature_checks.js`.

## Fix: checklist items and alarms not showing / disappearing (Nov 25, 23:20)
**Cause:** when two screens worked on the same case at about the same time (for example the owner adding an item or setting an
alarm while someone else, or the hand-over screen, saved another change), the later save sent that screen's own copy of the whole
checklist and wiped the items and alarms the other screen had just added. With realtime saving (every quarter second) and the
hand-over queue moving cases, this happened more often. Reproduced with two screens (`tests/live_checklist_merge.js`).
* A save now sends only the fields changed on that screen, so it never overwrites someone else's newer change to another field.
* The checklist (and work / part orders) is merged item by item: on the screen, and again on the server in one step, so two screens
  saving at the same moment keep each other's items, alarms, ticks and edits; an item deleted on a screen stays deleted.
* Older checklist items saved without an id now get the same id on every screen (and on the server), so they can be matched.
* Items and alarms already wiped before this update cannot be brought back by the app; their Case History lines ("Item added",
  "Reminder set") still show what was there.
* All earlier updates are kept. Tests: `tests/live_checklist_merge.js` (new), new checks in `tests/feature_checks.js` and
  `tests/test_frame.py`.

## THD / Non-THD lift, Excel for everyone in the report builder (Nov 26)
* **Lift type:** ticking *Lift required* in a case opens a small question: **THD lift** or **Non-THD lift** (Cancel leaves it as it
  was). The case shows e.g. "Lift required (Yes - THD lift)" with a *change* link; unticking clears it. Case History logs it. The
  weekly report (and the report builder's *Lift Required?* column) shows **Yes - THD lift**, **Yes - Non-THD lift**, **Yes** (older
  cases with no type) or **No**. The bulk upload understands "Yes - THD" / "Yes - Non-THD" in the Lift column.
* **Excel for everyone:** the *🛠 Report builder* tab (agents) downloads the builder Excel and now also has *Download weekly report
  (Excel)*. Checked with an agent screen.
* **Hand-over queue:** who sent a case to the queue is now saved with the case, so every screen applies "not back to the sender in
  the same shift" (it was only known on the screen that moved it).
* **Realtime updates re-checked** with two screens: a change (lift type) and typing in a case field reach the other screen within
  about a second; reopen after reload, attendance, checklist merge and sound tests all pass.
* Tests: `tests/live_lift_and_agent_excel.js` (new; uses `tests/mock_exceljs.js` because the Excel library comes from the internet),
  new checks in `tests/feature_checks.js`.

## Priority & SLA column, SLA in + Add Case, 3 handlers per case, checklist buttons (Nov 26, 04:00)
* **Checklist:** the 🗑 delete button on each checklist item and the *⏰ Change reminder* button in the *Acknowledge Checklist
  Item* pop-up are removed. Everything else on the item (Set reminder ⏰, Edit ✎, Acknowledge) is unchanged.
* **Priority & SLA column** (case list, right after *Account Name*): shows **High priority / Standard** (moved out of the
  *Status* column, which keeps severity, case status, Closed and Revisit) and the SLA: **NBD**, or **⚡ 4hr CTR / ⚡ 6hr CTR**
  highlighted in amber. The *Status* filter still filters by High priority / Standard.
* **SLA in + Add Case:** NBD · Next business day (default), 4hr call to repair, 6hr call to repair. It is saved on the case
  (new field `slaT`; the existing `sla` field stays the SLA Met / Missed record), logged in Case History, changeable in the case
  window next to the priority button, and available as *SLA Type (NBD / CTR)* in the report builder (not added to the weekly
  report).
* **3 handlers per case** (Settings → Shift Schedule, on by default; `config/hoq.chain`): a case is handled by at most three
  people until closed — the first agent of each region who held it (APJ → EMEA → AMS; region from the agent's schedule). When
  the hand-over queue deals a case, it goes back to that region's handler; an agent of a region that already has another handler
  does not get it. The **5 cases per agent every hour** pacing and the order (high priority, overdue, nearest due) are unchanged;
  new cases (round robin) are unchanged.
  * Handler of the region on shift not online yet (later shift, already got 5 this hour, Unavailable): the case waits in the
    queue — **unless the SLA would be missed** (reminder overdue or due within the hour, or a 4hr / 6hr CTR case): then an
    available agent takes it temporarily.
  * **Handler on leave / off today** (OFF, PTO, Absent or leave on the schedule): the **coordinator on duty** gets a pop-up
    "Temporary case ownership" (case, priority, SLA, next reminder) with **Approve · take the case**, **Decline** and **Later**
    (asks again in 10 min). Approved: the case moves to the coordinator as temporary owner (also on a day off on their schedule,
    since they are on duty). Declined, no coordinator on duty, or no answer within 15 min on an urgent case: the next available
    agent of that region takes it temporarily. Every step is logged in Case History.
  * A temporary owner is not counted as a handler: once the handler is on shift again the case goes back to them through the
    hand-over queue. The case window shows "Handled by: APJ … → EMEA … → AMS …" under the owner.
  * Manual transfers are not restricted by this rule.
* Tests: `tests/live_sla_and_handlers.js` (new), new checks in `tests/feature_checks.js` (regions stubbed so they don't depend on
  the time of day). Realtime saving re-checked: SLA changes and the approval reach the other screen within seconds.

## Approvals in one notification, Approve all, SLA tiles, new SLA colours (Nov 26, 04:45)
* **Temporary case ownership** requests are no longer a pop-up: they show in the same corner notification as transfer approvals
  (coordinator on duty), tagged *Temporary ownership*, with case, handler on leave, priority, SLA and next reminder, and
  **Approve**, **Decline** and **Open case**. It stays there until answered (the old *Later* button is gone with the pop-up).
  Approve / Decline do exactly what they did before.
* **Approve all:** when more than one request is waiting, the notification shows **✔ Approve all (n)**. It approves every
  waiting transfer request and temporary-ownership request one by one, with the same checks as the single buttons (for example a
  transfer to someone who is off today still stays with its owner, logged). Single Approve / Reject per request is unchanged.
* **SLA tiles:** + Add Case picks the SLA with three tiles (NBD · Next business day, ⚡ 4hr CTR, ⚡ 6hr CTR; NBD selected by
  default) instead of radio buttons; the case window uses small tiles instead of the dropdown. Typed fields are kept when a tile
  is tapped.
* **SLA colours:** 4hr CTR solid purple, 6hr CTR light purple with a purple ring (was amber), NBD light blue.
* Tests: `tests/feature_checks.js` and `tests/live_sla_and_handlers.js` updated.

## Case status beside severity, smaller text, readable profile name, playful alarm pop-ups (Nov 26, 08:50)
* **Case window header:** *Case status* is now a field like *Severity* (label above the box) on the same line; the *CSR only* tag
  sits next to its label. The priority button, SLA tiles and Case ID were made a little more compact so the whole row fits.
* **Text size:** the whole app is a little smaller (base 14px → 13px, phones 13.5px → 12.75px). The *Text size* setting in
  Settings → Theme still scales from there.
* **Profile name (top right):** the pill now has its own dark see-through background and always white text, so it stays readable
  on every colour theme, image skin and seasonal look.
* **Alarm pop-ups** (reminder alarms, *Acknowledge Checklist Item*, monitoring alerts, owner notifications, scheduled alerts, the
  test alert) and the approval notification got the playful look: bouncy pop-in, a ringing squircle icon, a sticker line
  ("Ding ding! Time to check ⏰", "Psst… a little note for you 💌" …), confetti dots, dashed details box, chunky pill buttons and
  a dotted, blurred backdrop. Colours still follow the theme; the Christmas lights and elves now wait for the pop-in to finish
  before they hang on the card edge. Content, buttons and sounds are unchanged; with the playful style switched off they look
  as before.
* Tests: new checks in `tests/feature_checks.js`; `tests/shim_integration.js` expects the new text size.

## Several revisits per case, readable logout and settings buttons (Nov 26, 09:20)
* **Revisits:** after the first revisit is saved, the Revisit section shows **＋ Add another revisit**. It opens the same fields
  (reason tiles, *Other* reason, Task ID, documentation) and adds *Revisit #2, #3…*, each with **Edit** and **Remove** and who
  added it and when. Case History logs *Revisit added / updated / removed*.
  * The first revisit stays in `c.revisit` (lists, filters and the dashboard work as before); the next ones are saved in the new
    field `rvMore`. Removing #1 keeps the others (the next becomes #1); removing the last one clears the tag as before.
  * The case list shows **↻ Revisit ×n** when there is more than one; the report builder's *Revisit Reason* and *Revisit Task ID*
    list every revisit ("Customer; DOA").
  * A half-typed added revisit is kept like other drafts (survives a reload) and changes reach other screens in realtime.
* **Log out and ⚙ Settings (top right):** same treatment as the profile name — their own dark see-through background, white
  text/icon and a light outline, so they stay readable on every colour theme, image skin and seasonal look.
* Tests: `tests/live_multi_revisit.js` (new), new checks in `tests/feature_checks.js`.

## Absent agents get no cases until available (Nov 26, 11:45)
* An agent shown as **Absent** in Agent Status (on shift but not logged in to PAT, or *Absent* on the schedule) gets no cases until
  they log in / become available. Round robin, the hand-over queue and balancing already left them out; now a **transfer by
  hand**, a **bulk transfer** and an **approved transfer request** are refused too ("… is marked Absent: cases can't be assigned
  to them until they're available"), the bulk-transfer list shows them as *(absent)* and disabled, and an approved request logs
  that the case stays with its owner. As soon as they log in, they can receive cases again.
* Tests: new checks in `tests/feature_checks.js`.
