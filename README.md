# GIH — Outlets Cover Report (web)

Four things in one page:

1. **Upload the Opera report** — the raw `Guest INH - Meal Plan` export — and it
   is folded into the GIH list, one row per room, with a review of exactly what
   the conversion did.
2. **Work the service** — cover sheets per outlet, a Master sheet across them
   all, and a **Dhathuru** briefing sheet: today's welcome and farewell with
   their flight and transfer columns, room moves, celebrations and the Haharu
   Host villa allocations.
3. **Build the GIH template** — download a `.xlsx` with the same nine sheets,
   XLOOKUP columns, PACKAGE totals, covers breakdown and highlight rules as
   `GIH Report.xlsx`, filled with that day's rooms.
4. **Change any of it in the Control Panel** — outlets, package buckets, what
   each covers line sums, the import rules, the colours — without touching code.

You can also work the cover sheets in the browser and skip Excel altogether:
same data model, same lookup behaviour, same cover-summary maths — without Power
Query or a shared OneDrive file two people cannot edit at once.

## Running it

There are two ways, and the app is the same either way.

**With the server** — one PC holds the day, every station sees it:

```
node server/server.js
```

or double-click `start-server.cmd`. It prints the address the other stations
should open, e.g. `http://192.168.1.40:8080/`. On first run it also prints the
admin password once — write it down. Node.js 18 or newer is the only
requirement; there is nothing to `npm install`, the server uses built-in
modules only.

**Without it** — double-click `index.html`. Everything works, but the day lives
in that one browser and nothing is shared. This is also what happens
automatically if the server is unreachable, so a server that goes down
mid-service does not stop the outlets.

Chrome or Edge 103+ is required for the `.xlsx` import (it uses the browser's
built-in `DecompressionStream`). Everything else works in any modern browser.

## The server

| | |
| --- | --- |
| Start | `node server/server.js` (or `npm start`) |
| Check it | `node server/verify.js` (or `npm run verify`) — starts a throwaway copy, exercises every route, prints pass/fail |
| Port | `set PORT=8090` before starting |
| Data | `server/data/` — plain JSON files, one per day, safe to copy or back up |
| Reset the password | `node server/server.js --set-password "something new"` |

The badge in the top bar says which mode you are in:

| Badge | Meaning |
| --- | --- |
| **Shared** (green) | Talking to the server. Seating is shared live with the other stations. |
| **Admin** (amber) | Signed in. You can upload reports and change the settings. |
| **This PC only** (grey) | No server. Everything still works, nothing is shared. |

### What the server owns

- **The day.** One upload reaches every station. Seating is shared live — the
  other stations pick a change up within a few seconds.
- **The settings.** The Control Panel is held centrally, so an admin changes the
  outlets or the package maths once and everybody gets it. Staff see it
  read-only.
- **The archive.** Each business date is its own document. Switching the date in
  the header opens that day; past days are listed under *Server & access*, and
  can be reopened or deleted. A date nobody has touched yet starts from the most
  recent GIH list, since one Opera export covers a range of dates.
- **A change log.** Who uploaded, who seated which outlet, who changed a
  setting, and when. Name each PC under *Server & access* and the log will say
  which one it was.

### Who can do what

Nobody has to sign in. Opening the app and working is the normal case; accounts
exist to give some people **more** than that, not to lock everyone out.

There are three levels:

| | What it is |
| --- | --- |
| **Not signed in** | Whatever is ticked under *Users & rights → Without signing in*. Out of the box: seat rooms and write Remarks. |
| **A named account** | Its own set of ticks, set by the admin. |
| **The admin password** | Everything, always. Separate from the accounts. |

The ten rights are:

| Right | Covers |
| --- | --- |
| Seat rooms and assign tables | the outlet sheets |
| Clear a whole outlet | the *Clear* button — the one that loses a sheet's work |
| Write the Remarks column | the one guest-list column filled in during service |
| Correct any other guest-list column | names, plans, pax, dates, comments |
| Change the business date | moving off today's sheet |
| Switch Lunch / Dinner | the toggle under the report title |
| Save a Master snapshot | the *Save to server* button on the Master tab |
| Edit the Dhathuru sheet | the five Dhathuru tables |
| Upload an Opera report | replacing the day for everybody |
| Reset the day | the *Reset* button — clears **every** outlet at once |
| Change Control Panel settings | outlets, packages, breakdowns, rules, colours |

Seating and clearing are deliberately separate: adding a room back is a moment's
work, emptying a sheet mid-service is not. The server tells them apart from the
rows themselves rather than trusting the browser — a write that empties an
outlet which had people on it needs the clear right, while emptying one that was
already empty is not a clear at all.

**Reset** clears every outlet for the business date, on every station. The guest
list is kept — it is the seating that goes. With no server it does what it
always did: back to the seed data on that one PC.

Only the admin can add accounts, delete a stored day, or read the change log.

### Which tabs each person sees

Under *Users & rights*, each account — and the not-signed-in case — has a grid of
tabs it can see. Untick one and it goes off that person's screen. New outlets
appear for everyone by default, since the list records what is *hidden* rather
than what is allowed.

An admin always sees every tab, so the switch that put a tab away can never end
up behind the tab it put away.

This is tidying, not a lock: the figures behind a hidden tab are still on the
API for anyone who goes looking. The rights above are the ones that actually
stop anything.

Every right is checked on the server as well as in the browser, so a greyed-out
button is a courtesy rather than the protection. Sessions last 12 hours.
Changing an account's password signs that person out; changing the admin
password signs out every other admin session. Five wrong guesses from one
address locks that address out for a minute.

Adding an account: *Control Panel → Users & rights → Add an account*. To sign
in as one, use the **Sign in** button in the top bar and give the name; leave
the name blank to use the admin password instead.

Changing it **from the Control Panel** requires at least 8 characters, because
that endpoint is reachable by anyone on the network. Changing it **from the
console** accepts anything — whoever is sitting at the server can edit
`server/data/admin.json` by hand regardless, so a length rule there would only
be for show:

```
node server/server.js --set-password "whatever you want"
```

A running server picks the new password up straight away; only sessions already
signed in stay valid until they expire.

### Two people editing the same outlet

Seating is checked per outlet. Two people working different outlets never block
each other. If two people edit the *same* outlet, the second save is refused,
the first person's seating is shown, and the second is told — nobody's work is
silently overwritten.

### Keeping it running

The server is a normal console program: the window it runs in is the server, and
closing it stops it. To have it come back after a reboot, put a shortcut to
`start-server.cmd` in `shell:startup`.

`server/data/` is the whole state. Copy that folder to back it up; drop it back
to restore. It contains real guest names, so treat it the way you would treat the
report itself.

## Opera → GIH

The Opera export is one row per **guest**: the room-level fields are written on
the first row of a reservation and left blank on the rows below it. The GIH list
is one row per **room**. The importer walks the sheet, groups the guest rows
under the room row above them, and folds each group down:

| GIH column | Comes from |
| --- | --- |
| Room No | `Room No.` on the group's first row |
| Remarks | left blank — it is the one column staff fill in by hand |
| Guest Name | every non-empty `Guest Name` in the group, joined with newlines |
| MealPlan | `Extra Meal Plan` when it has a value, otherwise `MealPlan` |
| Adults / Child | summed over the group (Opera puts the party total on one row) |
| Arrival / Departure | the group's first row |
| Comment | the *distinct* non-empty `Comment` values, joined with newlines |

Three things it cleans up on the way:

- **Report-title noise.** Opera leaks its own title (`Guest INH - Meal Plan`)
  into `VIP`, `Block Code` and `Extra Meal Plan` cells on page breaks. Any cell
  equal to the title in A1 is dropped, as are repeated header rows.
- **Plan codes.** Opera writes `FBCSAI` where the workbook's package bucket is
  `FBC+SAI`. Codes are matched on letters and digits alone, so those covers land
  in the right PACKAGE row.
- **Split reservations.** The same room twice in one export is merged — widest
  date span, summed pax, comments deduplicated. `XLOOKUP` only ever finds the
  first match, so leaving both would quietly hide one of them.

The import panel reports the row counts, the merges, and a tally of meal plans.
Plans shown in **amber** are not among the 15 package buckets, so those covers
land in no PACKAGE row — `RO` and blank plans usually. That is a fact about the
data, not a bug; it is surfaced so nobody has to notice it by hand.

The **Only rooms with status CHECKED IN** tick re-runs the conversion in place.
The uploaded file is not kept across a page refresh, so after one you have to
upload again for that tick to change anything.

## The generated workbook

*Build GIH template* writes a real `.xlsx`, built by hand — no library:

| Part | What it holds |
| --- | --- |
| `Sheet1` | the `Comments` table, `A1:I{n}`, with the day's rooms |
| 8 outlet sheets | `Room No` + `Table #` to type into, the other 8 columns looked up |
| PACKAGE block | the 15 buckets, `SUMIF` over the sheet's own MealPlan column |
| Covers breakdown | `DINNER PKG` … `TOTAL`, on the outlets that have it |
| Conditional formats | the same four rules, same colours, same priority order |

Room numbers are written as **numbers**, as the source workbook has them —
`XLOOKUP` is type-strict, and staff type `104` into an outlet, not `"104"`.

Two deliberate differences from `GIH Report.xlsx`:

- The outlet lookups are one scalar `XLOOKUP` per column instead of one spilling
  `XLOOKUP` across a column range. Identical values, no `#SPILL!` risk.
- The **OT** roll-up uses `TOCOL(VSTACK(…))` over the three OT sections named
  individually. The source workbook uses `TOCOL` over a 3-D reference, which
  Excel rejects — its own saved value for that cell is `#VALUE!`. The generated
  file spills the sections' rooms properly.

Both `XLOOKUP` and `TOCOL`/`VSTACK` need Excel 365 or Excel 2021+, the same as
the original workbook.

If a browser is configured to block site data on `file://` URLs, the app still
works but will not remember seating between refreshes. If that happens, serve
the folder over HTTP instead of opening the file directly.

## How it maps to the workbook

| Workbook | Web app |
| --- | --- |
| `Sheet1` / table `Comments` (Power Query "Query - Comments") | **Guest In House** tab |
| The 8 outlet sheets | The 8 outlet tabs |
| `XLOOKUP(A2, Comments[Room No], …)` | Typing a room number in an outlet |
| the `SUMIF($E$2:$E$100, …)` block (rows 103–117 on Skipjack; each outlet sheet puts it at its own offset) | **Package** panel |
| `DINNER PKG` / `GIH FOOD` / `GIH BEV` / `AI` … `TOTAL` | **Covers breakdown** panel |
| Conditional formatting on `A2:J201` | Row highlighting (see below) |

### Row highlighting

Reproduces the workbook's four conditional-format rules, in the same priority
order and the same colours:

| Rule | Colour | Workbook formula |
| --- | --- | --- |
| Departure on the business date | `#FF7575` red | `$I2=TODAY()` |
| Has a Remarks value | `#FFFF85` yellow | `$C2<>""` |
| Arrival on the business date | `#C5E0B4` green | `$H2=TODAY()` |
| Alternating rows | grey | `MOD(ROW(),2)=0` |

Rooms typed into an outlet that are **not** in the GIH list are shown in pink
instead of silently returning blanks, which is what the `XLOOKUP` fallback
`""` does in the workbook.

### Covers breakdown

Cell-for-cell equivalents of the workbook's derived rows (indexes are into the
15 package buckets `AI, SAI, PAI, BAI, FB + SOFT BEV, FB, HB, BB, FBC+SAI,
FBC, BBC, AIC, SAIC, COMP, HBC`):

| Line | Workbook | Buckets |
| --- | --- | --- |
| DINNER PKG | `SUM(F103:F109, F111:F112)` | AI…BB minus BB, plus FBC+SAI, FBC |
| GIH FOOD | `SUM(F103:F112)` | first 10 |
| GIH BEV | `SUM(F103:F107, F111)` | AI, SAI, PAI, BAI, FB + SOFT BEV, FBC+SAI |
| AI | `SUM(F103, F106)` | AI, BAI |
| PAI | `SUM(F105)` | PAI |
| SAI | `SUM(F104, F107, F111)` | SAI, FB + SOFT BEV, FBC+SAI |
| FB | `SUM(F108, F112)` | FB, FBC |
| HB | `SUM(F109)` | HB |
| BB | `SUM(F110, F113)` | BB, BBC |
| ENT | `SUM(F114:F117)` | AIC, SAIC, COMP, HBC |
| TOTAL | `SUM(F103:F117)` | all |

Lines that sum to zero show `—`, matching the workbook's
`IF(SUM(…)=0, "", …)`.

## Control Panel

The last tab. Everything that used to be a constant in the source lives here, so
a new outlet or a new package code is a settings change, not a code change. Each
section shows a dot in the nav when it differs from the shipped defaults, and
has its own *Reset this section*.

| Section | What it controls |
| --- | --- |
| **Property & report** | The corner badge, the window title, the workbook title, the download file name (`{date}` and `{property}` are substituted), how many rooms the resort has, and whether the *Import & Template* tab is shown. |
| **Outlets** | Add, rename, reorder and remove outlets. Per outlet: how many rooms can be typed in, whether it gets a PACKAGE block and a covers breakdown, the blank rows before the PACKAGE header, and which sheets it rolls up from. Also picks which outlets the Master tab compiles. |
| **Package buckets** | The list every outlet totals covers into, in PACKAGE-block order. |
| **Covers breakdown** | The Lunch/Dinner switch, and the lines under the PACKAGE block. Tick the buckets each one sums; set adults-only, bare-number, emphasis, whether the name follows the service, and the blank rows above it. |
| **Import rules** | Whether `Extra Meal Plan` wins over `MealPlan`, whether duplicate rooms merge, which reservation statuses count as in house, and any meal-plan renames. |
| **Plan from comment** | Override a room's meal plan when its Comment contains a given piece of text. See below. |
| **Highlighting** | The four conditional-format colours, shown against the workbook formula each one fires on. |
| **Workbook output** | Date format, frozen header row, and the outlet-sheet legend. Also lists the sheets that will be written, with their row ranges. |
| **Settings file** | Export the settings as JSON, import them on another machine, or reset everything. |
| **Users & rights** | What people can do without signing in, and the named accounts with a set of rights each. |

A change applies immediately — to the tabs, the summary maths, the CSV export
and the next workbook you build. If the Opera file you uploaded is still in
memory, changing an import rule re-runs the conversion on the spot.

Two renames are handled rather than left to bite later: renaming an outlet
carries its seating across and repoints any roll-up that names it, and renaming
a package bucket repoints every breakdown line that sums it. Outlet names are
checked against Excel's worksheet-name rules, since each one becomes a sheet.

Settings are stored per browser, separately from the day's data — *Reset* in the
header clears the seating, not the settings.

### Lunch or Dinner

The toggle sits under the report title in the top bar, because it gets flipped
between sittings rather than once a season.

**Each service has its own covers breakdown.** Switching is not a rename — it
swaps the whole list of lines, so lunch can count differently from dinner
without either being kept in step by hand. The Control Panel edits whichever
service is switched on, and says so; *Copy this breakdown to …* seeds one from
the other when they should start the same.

Both start identical to the workbook's. On top of that, tick **Name follows
service** on a line and its leading service word tracks the switch, so a single
`DINNER PKG` line reads `LUNCH PKG` at lunch — in the summary panel, the CSV and
the generated workbook. A line with no service word simply gains one.

Flipping it needs the *Switch Lunch / Dinner* right, which can be given out on
its own — someone can be allowed to change service without being allowed near
the rest of the settings.

### Plan from comment

The reservation comment usually spells the real arrangement out even when the
MealPlan column does not — a room carrying
`COMP/1RO/1TRRT - Meals in Staff Canteen` is a COMP cover whatever Opera says.
Each rule reads as a sentence:

> Comment contains `COMP/*FB` → count as `COMP`

with two options: **only when the room has no plan at all** (so the rule fills a
gap rather than overriding a real plan) and **match case**. Rules are tried top
to bottom and the first match wins, so put the specific ones above the general
ones — reorder them with the arrows.

**Wildcards.** The pax count moves from booking to booking — `COMP/1FB` today,
`COMP/4FB` tomorrow — so the text accepts two wildcards:

| | |
| --- | --- |
| `*` | any run of characters |
| `?` | exactly one character |

Neither crosses a space, so a wildcard stays inside one word. That is what makes
`COMP/*FB` mean "one `COMP/…FB` token" rather than "`COMP/` somewhere, then `FB`
much later in the comment" — and on the sample data it matters: two rooms carry
`.../1COMP/1 Infant` (a complimentary infant, not a comp room) while also
mentioning `FB` elsewhere in the same comment. A plain `COMP/` rule sweeps those
two up wrongly; `COMP/*FB` leaves them on their real plans.

Everything else is matched literally, so `$912`, `(Bite)` and `20+10+05%` all
work as typed — no escaping to think about.

Each rule shows how many of the rooms currently loaded it catches, and names a
few, so it can be checked against real data before it is trusted. That count
already accounts for rules above it winning first.

Rules apply to Opera imports and GIH workbooks alike, and are re-applied the
moment you change one. Every record keeps the plan it arrived with, so removing
a rule puts the original plan straight back — no re-import, and running the
rules twice never compounds.

The override flows all the way through: the Guest In House list, the outlet
PACKAGE totals, the covers breakdown, the CSV, and the `MealPlan` column of the
generated workbook.

## Daily use

1. **Upload the day's report.** On the *Import & Template* tab, click
   *Choose a file* — or drag the file anywhere onto the page, from any tab. An
   Opera export is converted; a GIH workbook is loaded as-is. The format is
   detected from the header row, so there is nothing to choose. `.csv` is also
   accepted.
2. **Set the business date.** It drives the arrival/departure highlighting and
   the in-house counts. If today falls outside the report's window the date
   snaps to the report's own snapshot date (its latest arrival). Online, each
   date is its own shared document and moving off today needs the *Change the
   business date* right — otherwise the picker is greyed out, so nobody wanders
   off the current service by accident.
3. **Seat rooms.** On an outlet tab, search by room, guest name or anything in
   the comment; the matches drop down with their plan and pax, and clicking one
   seats it. ↑/↓ and Enter work too. If you already have the numbers, paste a
   whole list — they are split on spaces, commas and newlines and added
   straight away, no picking. *Fill in-house* is on **OT - Breakfast** only,
   where everybody is in anyway; on the other outlets it only made a sheet to
   prune.
4. **Assign tables.** The Table # column is free text, so `12`, `12/13` and
   `A4` all work.
5. **Hand it over.** *Print* gives an A4 landscape cover sheet with the summary;
   *Export CSV* gives the same thing including the full package block; and
   *Download GIH Report .xlsx*, on the *Import & Template* tab, gives the whole
   workbook back.

Uploading and building both live on the *Import & Template* tab. They used to be
duplicated in the top bar as well, which meant one of the two places was always
the wrong one to look.

Click any comment to expand it.

### The Dhathuru tab

The daily briefing sheet for the business date: the five tables of the real
Dhathuru, with its columns and in its order.

| Table | Columns |
| --- | --- |
| **Today's Welcome** | Room · Status · Guest Name · ETA to Fares · Departure Date · Pax · Nat · VIP · Meal Plan · Travel Agent · Haharu Host · Remarks |
| **Today's Farewell** | Room · Status · Guest Name · Check-Out Time · Dep Time from Resort · Nat · Pax · VIP · Meal Plan · Travel Agent · Haharu Host · Remarks |
| **Room Moves** | From · To · Guest Name · Time · Travel Agent · No of Pax · Haharu Host · Remarks |
| **Celebration** | Room · Guest Name · Celebration · Location & Time · Bed Decoration |
| **Haharu Host Villa Allocations** | Name · 20 numbered villa slots · Remarks |
| **This Week Summary** | read-only, from the uploaded file: Daily OCC%, Adults / Children In-House, Welcome and Farewell Rms, Occupied Rms, OOO Rms, Welcome and Farewell No. of Guests, a column per date |
| **The header block** | read-only: ADR, Welcome and Farewell Rooms / Adult / Child, Targets |

**Times and dates tidy themselves up.**

| Cell | Takes | Shows |
| --- | --- | --- |
| ETA, Check-Out, Dep Time, Room Move Time | `830`, `8.00`, `8:30am`, `18:10`, or an Excel serial like `0.3541666…` | `08:30 AM` |
| Departure Date | `9/1/2026`, `2026-09-01`, or an Excel serial like `46266` | `01 Sep` |

The Excel serials matter: a spreadsheet keeps a time as a fraction of a day and
a date as a count of days, so an uploaded sheet hands over `0.3541666…` where it
shows `8:30 AM`. Those are converted on the way in, and a sheet saved before
this understood them is tidied the next time you open the tab.

Slashed dates are read **month-first**, because `8/31/2026` in the source can
only be 31 August. Anything that cannot be read is left exactly as typed, so
`TBA` in a Departure Date still works.

Above the tables sits the sheet's **own header block**, laid out as it is on the
Dhathuru and read straight from the uploaded file:

| | |
| --- | --- |
| left | ADR, Welcome Rooms / Adult / Child, Farewell Rooms / Adult / Child, then the **Targets** |
| right | the day it was written for, over the full **This Week Summary** with the business date's column picked out |

None of it is worked out here — the house count, the occupancy and the targets
are all the Dhathuru's, because none of them are in the Opera export. The
**HOTLINES** column beside the targets is deliberately left behind: it is a wall
phone list, the same every day, not part of the briefing. The header replaced an earlier strip of figures that tried to
derive them from the guest list and got them wrong: an Opera export is a
snapshot of the rooms in house when it was taken, not the whole island a week
later.

**One upload covers the whole week.** The week summary and the targets carry to
every date the summary lists, so moving to 31 Aug shows that
day's 138/30 at 34% without another upload. The five day tables do not carry —
those are that day's own — and neither does the title, since it names the day it
was written for.

The rooms / adults / kids in the **top bar** are a different thing again: they
count the **uploaded Opera report** as a whole — the same 94 / 214 / 48 the
conversion report gives — not the rooms in house on the business date. The tiles
do not say which they are, so they say what was uploaded.

**Finding a villa.** The host grid has a search box: type a villa number and it
tells you straight away — *412 → Leesha (slot 7)* — highlighting the cell and
dimming the hosts who do not have it. Reading twenty columns across a dozen
rows was the slow way to answer the question this grid gets asked all day.

**The tables themselves are the Dhathuru's own.** Flight numbers, transfer
times, luggage pick-up, nationality, travel agent, VIP and Haharu Host are not
in the Opera export, so they are entered here or read from an uploaded Dhathuru
file — not invented from the guest list.

What the guest list *can* give you is on the **Fill from guest list** button on
Welcome and Farewell: it brings in today's rooms, names, pax and meal plans and
leaves the flight and transfer columns blank for the transfer sheet. A gap is
better than a guess in a briefing sheet.

Click a cell and type; *Add* puts a line on, ✕ takes one off. Everything saves
to the server as you go, so every station sees the same sheet, and the header
says when it was last saved and by whom. It needs the *Edit the Dhathuru sheet*
right, which is on by default for everyone — it is floor work, like Remarks.

*Export CSV* writes all five tables plus the house figures. *Print* gives it as
a briefing sheet.

### Uploading a Dhathuru file

*Import & Template → 2 · Upload the Dhathuru* reads all five tables out of a
Dhathuru workbook. It matches on **column headings**, not positions, so the
tables can sit anywhere, on any sheet, in any order, behind their banner rows.

Three rules keep it right on a sheet holding five tables one under another:

- a heading row has to match **two or more** of a table's columns, so a banner
  row like `ROOM MOVES` is never mistaken for one. A banner is recognised as
  *one distinct value* across its row rather than one filled cell, because a
  banner is usually a cell merged across the full width — and expanding merges,
  which is what makes the transfer times fill down, repeats that text into every
  column;
- Welcome and Farewell share most of their headings, so each also has to show
  one of its own. The reader still looks for the arrival-flight, ETD, luggage,
  transfer and ETA-to-MLE columns for exactly this reason, even though those are
  no longer shown on the tab — it reads them to tell the two tables apart, then
  drops them;
- a table ends at a **blank row or the next banner**, so it cannot run on and
  swallow the section beneath it.

A host with no villas yet stays on the roster rather than being dropped, and the
`AvaniFit & Wellness` and `OUR OFFERINGS` headings printed under the Celebration
table are skipped — they are not celebrations.

The header block is matched by **label** rather than position, because it is a
patchwork of merged cells whose columns shift about: `ADR`, the two
`… Rooms / Adult / Child` lines, and the block under `TARGETS`. Those two take
the first cell to their right. The targets are a strict two-column block —
label, then value in the very next column — and end at the first row that breaks
that shape, because below them the sheet carries on with full-width merged
notices and a value looked for further right would find the week summary
printed alongside them. The week
summary's row labels are read from the column directly under
`This Week Summary`, not the first non-empty cell on the line, since the header
block is printed alongside it on the same rows.

**Merged transfer times.** Guests sharing a boat share one merged cell, so only
the first row of each group carries the time and the rest look empty. A workbook
records those merges, and the reader expands them — every row of the group ends
up with its group's time. A CSV cannot record a merge, so there the value is
carried down instead, and only for the three columns that are genuinely merged:
*ETA to Fares*, *Check-Out Time* and *Dep Time from Resort*. Carrying anything
else down would invent data.

The Opera importer deliberately does **not** expand merges: it groups a
booking's guest rows by exactly those blanks, and filling them would turn every
guest into their own booking.

If nothing matches, it says so and **lists the headings it did see** on each
sheet, so the reader can be taught whatever the file actually looks like.

### Compiled tabs: Master, and OT

Two kinds of tab show the same compiled sheet over a different set of outlets:

- **Master** — by default every outlet. An admin can narrow it under
  *Control Panel → Outlets → What the Master tab compiles*.
- **A roll-up outlet** — one that names other sheets in its *Rolls up from*
  column. **OT** ships that way, compiling `OT - Section 500`,
  `OT - Section Outdoor` and `OT - Section 700`, which is what the OT sheet does
  in the workbook. There is no room box on such a tab: it shows what those
  sheets hold.

Either way you get the outlet and table alongside each room, a filter by outlet
and a search across the lot, and a summary panel that totals **whatever is on
screen** — so filtering to one outlet gives that outlet's numbers without
leaving the tab. *Export CSV* writes what you are looking at.

Both are read-only: a seating is changed in the outlet it belongs to. They are
also the only views that can see a room seated in **two outlets at once**, which
is nearly always a mistake, so those rooms are marked ⚠ and named above the
table.

If you narrow the Master tab, don't tick both a roll-up outlet and the sections
it rolls up — those covers would be counted twice.

**Save to server** (Master only) stores the sheet as it stands, with who saved
it, when, which service, and an optional note. It is a record of what the floor
actually worked from, kept against that business date; the last dozen are held.
It needs the *Save a Master snapshot* right.

### Editing the Guest In House list

| Column | Who can change it |
| --- | --- |
| **Remarks** | anyone, signed in or not |
| everything else | admin only (or anyone, with no server) |

Click a cell and type. Enter or clicking away saves; Escape puts it back. Guest
Name and Comment take newlines, so Enter adds a line there instead.

Remarks is the column that gets filled in during service, so it is deliberately
open to everyone — and it drives the yellow row highlight. Each remark is sent
on its own, so two people noting different rooms never overwrite each other.
The rest describes the reservation, and correcting it is the admin's job because
everyone is looking at the same list.

Bad values are refused rather than stored: Adults and Child must be whole
numbers, dates must be `yyyy-mm-dd`, a room number cannot be blank or duplicate
another. A meal plan set by hand also sticks — a comment rule will not overwrite
a decision someone made deliberately.

### Putting lines on the Guest In House list

The Opera export is not always the whole story — a late booking, a day-use room,
a guest the export was taken before. Two buttons on the tab head add lines by
hand, each with its own right in **Control Panel → Users & rights**:

| Button | Right | |
| --- | --- | --- |
| **Add** | *Add a blank line to the guest list* | also needs *Correct any other guest-list column*, since the line it makes is empty and has to be typed into |
| **Add from Today’s Welcome** | *Add to the guest list from Today’s Welcome* | stands on its own — the lines it brings over are already filled in |

Both are hidden from anyone without the right, and the server checks again on
the way in. The list travels whole, so either add right is enough to write it.

**Add** puts a blank line at the bottom with **Arrival set to today**, clears any
filter that is on, and drops the cursor in its Room cell. A blank line matches no
filter, so adding one under a live filter would otherwise look like nothing had
happened.

**Add from Today’s Welcome** brings the Dhathuru's Welcome table across. The two
sheets do not say the same things the same way, so the columns are translated on
the way over:

| Today’s Welcome | Guest In House | |
| --- | --- | --- |
| Room | Room No | `421 / D/U` becomes `421` — the number is what every lookup matches on |
| Guest Name | Guest Name | as-is, newlines and all |
| Pax | Ad + Ch | `2+1` is 2 adults and 1 child; `2` is 2 and 0 |
| Departure Date | Departure | `01 Sep` becomes `2026-09-01` |
| Meal Plan | Plan | upper-cased |
| Remarks | **Comment** | the guest list's own Remarks column stays empty — that is the one staff write in during service |
| — | Arrival | **today**, always |

A departure printed on a briefing sheet carries no year, because a Dhathuru is
one day's sheet and does not need one. The year is taken from the business date,
rolling forward when that would put the date behind it: `05 Jan` on a December
sheet is next January, not last.

**A room may hold two lines, and no more.** One room really can be occupied
twice in a day — a day use that checks out before the next guest arrives, or a
split reservation — and the Opera export flattens those into a single line, so
bringing the second one in by hand is the only way to see it. Adding gives a
room its second line; a third is refused, and the toast says how many went on
and how many rooms were already full. Typing a room number into a cell obeys
the same limit.

The limit is two because every lookup in the workbook takes the **first** match:
a second line is visible on the outlet sheets — the seated row carries a
*duplicate room in GIH — first match shown* note — but past two they are only
noise. If two is ever the wrong number, it is `GIH_ROOM_LIMIT` in `app.js`.

The **✕** at the end of each row takes a line off again. It is there because
lines can be added by hand now, and re-importing the whole export to undo one
mistake would throw away every other hand-made change with it. If the room is
seated in an outlet, the confirm says so: those seats stay, but show as not in
house.

### Filtering the Guest In House list

Under the column headers is a filter row: type into any of them to keep only the
rows whose value for that column **contains** what you typed, case-insensitively.
Filters combine — several columns narrow the list together, and they stack on top
of the search box and the plan / status pickers. Active boxes are outlined, and
*Clear filters* appears while anything is on.

The date columns match either form, so `2026-08-24` and `24 Aug` both work on
Arrival and Departure.

**Duplicate Room No** in the status picker keeps only the rooms the list names
more than once, which puts the two lines of each next to each other. It is how
you check that a second line is meant rather than a slip — worth a look after
adding from Today’s Welcome, since only the first line of a room is ever looked
up by the workbook.

*Export CSV* on this tab writes the rows you are looking at, not the whole list —
the filtered view is the hand-over.

## Data and storage

Everything stays in the browser. The GIH list and all outlet seating are saved
to `localStorage` on the machine you are using, so a refresh or a reboot does
not lose the seating plan. Nothing is uploaded anywhere. *Reset* clears the
seating and returns to the bundled seed data.

Because storage is per-machine and per-browser, two stations do not share a
seating plan — export or print to hand one over.

## Files

```
index.html               markup + the view templates
start-server.cmd         double-click launcher for Windows
package.json             scripts only - there are no dependencies

assets/api.js            client for the backend, and the offline fallback
assets/config.js         master settings + defaults; every module reads these
assets/control-panel.js  the Control Panel tab, a view over config.js
assets/styles.css        styling, workbook highlight colours, print layout
assets/app.js            state, lookup, summary maths, import/export, sync
assets/opera.js          Opera "Guest INH - Meal Plan" -> GIH records
assets/xlsx-reader.js    dependency-free .xlsx/.csv reader
assets/xlsx-writer.js    dependency-free .xlsx writer (zip + SpreadsheetML)
data/seed.js             107 rooms extracted from GIH Report.xlsx, as a fallback

server/server.js         HTTP, static files, first-run password
server/lib/api.js        every route, with storage and hashing injected
server/lib/store-fs.js   the JSON-file store behind that
server/lib/web.js        cookies, bodies, static serving, scrypt
server/verify.js         end-to-end self-test
server/data/             live state (created on first run; not in the repo)
```

`server/lib/api.js` deliberately has nothing environment-specific in it —
storage, hashing, tokens and the clock are all injected. Node wires it to the
filesystem; a test can wire it to a Map. The routing, the admin gate and the
conflict rules are the parts most worth testing, and this way they can be tested
without a server running.

The `server/` folder sits inside the web root so the whole thing is one folder
to copy, and is explicitly refused by the static handler — `server/data/` holds
the password hash and the guest names.

`config.js` holds the defaults, which reproduce `GIH Report.xlsx` exactly —
including its own layout drift, like the PACKAGE block sitting 2 rows below the
data on Skipjack and 10 rows below it on Charcoal and Tribe.

`data/seed.js` contains real guest data from the source report. Replace it with
an anonymised set (or an empty `[]`) before sharing this folder outside the
team.
