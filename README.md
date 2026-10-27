# Caffeine

A switch for the Mac's sleep, inside [Paseo](https://getpaseo.com): on the desktop,
on the phone, and per host when several are connected.

> **Developers and agents: read [Definition of Done](#definition-of-done-chatgpt-sees-it-too)
> before you finish anything.** Caffeine is driven from ChatGPT through God Mode as well as from
> the page, and ChatGPT can use only what `meta.describe` declares. Every new feature, status
> field, metric or UI action needs its describe entry in `server/capabilities.server.ts` (or a
> stated reason it has none), with its risk, confirmation, honest answer and tests. A change
> without them is not done.

Agents keep working after you walk away; a MacBook on battery does not. Until now the
machine stayed awake only because Orca ran `caffeinate` underneath itself. This plugin
gives Paseo the same lever with three positions:

| | |
|---|---|
| **On** | The Mac does not sleep until you say otherwise. Survives a daemon restart. With the lid switch on, the lid can close too, with no end. |
| **30 min … 12 h** | The Mac does not sleep until the deadline, then the switch goes back to Off by itself. Six lengths: 30 min, 1 h, 2 h, 3 h, 8 h, 12 h. With the lid switch on, the lid can close until the same deadline. |
| **While agents work** | The Mac does not sleep while at least one Paseo agent on this host is running, and for three minutes after the last one went quiet. |

Off, On, **Sleep now**, which sends the Mac under from wherever you are, and While agents
work share the top row, with the timer's six lengths under them. **Keep display on**,
**Lid can close** and Session warm-up share the last row, each switched by a press on its
tile (− and + move the warm-up's hour). Below the modes is the link that wakes the Mac
again. The timer and Session warm-up are hidden until switched on in Settings → Plugins →
Caffeine → Settings; hiding warm-up switches it off too, so it never runs unseen, while a
timer already running still ends on time.

Only system sleep is held and the display sleeps as usual — unless **Keep display on** is
switched on, which holds both whenever the Mac is held. A closed lid still sleeps a MacBook,
`caffeinate` or not.

**Lid can close**, the switch next to Keep display on, is the one exception to that. With it on, the
timer lets the Mac run with the lid shut until its deadline, and On lets it run with no end;
Off and While agents work turn lid mode off, and the switch stays as it was for next time.
It flips the system's own `pmset disablesleep`, which needs root, so the first press asks for
that: macOS asks for the password (or Touch ID) once, a sudoers rule allowing exactly
`pmset -a disablesleep 1` and `… 0`, checked with `visudo` first, goes into
`/etc/sudoers.d/paseo-caffeine`, and the switch comes on. After that the switch works
from the phone too. Sleep comes back by itself at the deadline, on battery below 20%, and
before **Sleep now**. A guard does the same even if Paseo is not running by then: a
LaunchAgent (`~/Library/LaunchAgents/com.paseo.caffeine.lid-guard.plist`) that waits for the
deadline, restores sleep (retrying for up to half an hour until `pmset -g` confirms it) and
removes itself; after a reboot it runs again at login. macOS may announce it as a new
background item (shown as `sh` in System Settings → General → Login Items); switched off
there, lid mode refuses to start, since nothing would bring sleep back. Caffeine only lets
go of the deadline once `pmset -g` confirms sleep is back, so a failed attempt is retried.
Under **On** lid mode has no end, so its guard waits for Caffeine rather than a deadline: it
lasts until you turn it off (another mode, the switch, the header, or Sleep now), the battery
drops below 20% off the charger, macOS reports the Mac running hot (`pmset -g therm`, which
never happens on Apple Silicon; the heat guard below covers that), or
Caffeine goes quiet for ten minutes (Paseo quit or crashed, the plugin disabled or failing to
load), when the guard puts sleep back. Caffeine beats every thirty seconds, into
`~/.jobby-jobs/caffeine-lid-heartbeat`; after a reboot the ten minutes count from login, so a
Paseo that starts at login picks lid mode up again. The heat check applies under the timer too.
Lid mode that ended on a low battery or heat, or was turned off by Sleep now, the header
or by hand, stays off until you ask for it again: while the switch is on and a timer or On
runs, the card says who turned it off and that a closed lid now sleeps the Mac, next to
**Turn back on**, which picks lid mode up for the rest of the timer (or with no end under On).
While lid mode is on, closing the lid puts the screen to sleep (`pmset displaysleepnow`,
checked once a minute while the lid stays shut, so a panel woken under a closed lid goes dark
again; not with an external monitor attached, which it would blank too (also one plugged in after the lid closed); with Screen Sharing into a closed Mac the shared
screen goes dark every minute too). Lid mode switches sleep off system-wide. Battery and heat
are watched only while Paseo runs, which is why both guards keep working without it: a timer's
until its deadline, On's for ten minutes (macOS's own low-battery and thermal shutdowns still
apply). By hand: `sudo pmset -a disablesleep 0`. To undo the permission:
`sudo rm /etc/sudoers.d/paseo-caffeine`.

### Heat protection

Lid mode is also what takes macOS's own way out of a hot bag away: the kernel checks
`disablesleep` before its thermal-emergency sleep (xnu `checkSystemSleepAllowed`), so while lid
mode is on nothing in macOS would put an overheating Mac to sleep. Caffeine does, while lid mode
is on (off it, a closed lid sleeps the Mac and the kernel's emergency sleep gets past
caffeinate). Four triggers, read every 15 s:

- **Thermal pressure**, macOS's own verdict over all its sensors (`com.apple.system.
  thermalpressurelevel`, public in `OSThermalNotification.h`, readable without root): Heavy held
  for 60 s by default; Moderate and its delay can be picked in Settings, and Heavy still fires
  within 60 s under it; Trapping and above at once, always. On Apple Silicon this replaces
  `pmset -g therm`, which never reports anything there.
- **The battery at 45 °C**, two readings in a row: Apple's upper storage temperature for a
  MacBook Pro and the usual Li-ion charging limit, read the same way on every Mac. Fixed.
- **No readings** (neither pressure nor battery) for 90 s with the lid closed. Fixed.
- **The fans**, with the lid closed: any fan at the chosen share of its own maximum (85 % by
  default, 5 % steps, from 10 points above the fans' floor to 95 %) for the chosen time (60 s by
  default). Set in the popup that opens from the fan reading on the page. Fans stay at their
  floor in a closed bag, so this one catches a Mac working flat out, not a hot bag.

A trip runs one sequence, from the plugin or from the LaunchAgent guard, whichever sees it
first (a lock keeps it to one): the latch is written; `sudo -n pmset -a disablesleep 0`,
confirmed by `pmset -g`; Caffeine's own caffeinate is stopped (only that one: the pid it wrote,
still `caffeinate … -w <plugin pid>`); `pmset sleepnow`; then a look whether it slept (the wall
clock running ahead of the monotonic one), up to three tries, with whoever else holds
PreventSystemSleep written down if it did not. While the latch holds, lid mode stays off,
Caffeine's hold stays off with the lid closed, and a Mac woken with the lid closed goes back to
sleep, at most once a minute. Lid mode comes back only by hand, once the battery has stayed at
or under 38 °C with the pressure Nominal for the cool-down (5 minutes by default, Settings).

The LaunchAgent guard runs the same rules in sh from `~/.jobby-jobs/caffeine-thermal.conf`, so
the protection does not depend on Paseo, the plugin, the relay or the network. It is restarted
by launchd if it dies (`KeepAlive`), logs to `~/.jobby-jobs/caffeine-guard.log`, and switches
sleep back on when it is stopped at logout (but not when the plugin replaces it, which it says
through `~/.jobby-jobs/caffeine-guard-handover`).

CPU temperature and fan speeds come from a small read-only helper (`server/sensors-source.ts`),
which the plugin builds with clang on first use into `~/.jobby-jobs/bin/`. Without the Xcode
command-line tools it is not built (clang is not even started, so macOS does not offer to install
them): the page then shows no CPU and "—" for the fans, and the fan trigger is off; pressure and
the battery need nothing built.

**Dry run and simulation.** While `~/.jobby-jobs/caffeine-thermal-dryrun` exists, both halves
only say what they would have done (in the log and on the page, marked "dry run"); nothing is
switched, stopped or put to sleep. `~/.jobby-jobs/caffeine-thermal-simulate` replaces the
plugin's readings for looking at the page — any of `pressure=0…4|none`, `battery=45.5|none`,
`cpu=88|none`, `fans=rpm/min/max,…|none|unknown`, `lid=open|closed`, `armed=1` (pretend lid mode is
on) — and a simulated reading is always a dry run. The guard never reads the simulation.

**What it cannot promise.** macOS gives no way to guarantee sleep: on the charger another app's
PreventSystemSleep turns `sleepnow` into a DarkWake and cannot be taken away without root (it is
named on the page instead); if sudo or pmset fail, `disablesleep` stays 1 and nothing sleeps; a
dead or misreading guard does nothing; Power Nap, network and Bluetooth wakes come back (the latch
sends the Mac down again). The pressure key on Intel Macs is untested.

The surface also shows the Mac's own battery: charge, whether the charger is in, and how
long the charge has left — or how long until it is full. Under it, the watts, the way
Wattage Connected shows them: on the charger, a bar as long as the charger's rating, split
into what goes into the battery, what the Mac itself takes (the draw less the battery's
share) and what the charger has left, with the two figures in a column underneath; off the
charger, what the Mac takes from the battery. How old the reading is shows only once it is
older than a minute and a half.

## Installing it

```sh
paseo plugin add git:kostilal/paseo-caffeine
paseo plugin update caffeine               # later, to take what is new on main
```

Then **Caffeine** in the sidebar, or ⌘K and type "caffeine".

To work on it from a clone instead:

```sh
npm install
paseo plugin install ./paseo-caffeine      # once
paseo plugin reload caffeine               # after every change
```

## How it works

The server half runs `caffeinate -i -s -w <its own pid>` as a child process while the
policy says so, and re-evaluates every thirty seconds: it asks the daemon how many agents
are running, reads the battery, moves a busy window, and starts or stops the child. `-w`
ties the child to the plugin, so a plugin killed without cleanup takes its `caffeinate`
down with it. Timer holds add `-t` as a second guard, and **Keep display on** adds `-d`.

**Keep display on** and **Lid can close** ride on their own RPC that takes a patch, rather
than on the mode: the display is a property of the machine you sit at, and the lid switch
says what the timer and On mean, not which of them runs. Both survive a mode change and a
spent timer alike. The controller turns lid mode on only when a person changes the mode or
the switch, never on a tick. A tick only ever turns it off, and only lid mode with no end
that neither the mode nor the switch asks for any more (a turn-off that did not take, or a
timer picked under On that could not take it over and has run out): it has no deadline, and
its guard only steps in once Caffeine has gone quiet, so while Caffeine runs nothing else would
end it.

## Sleeping, and getting back

**Sleep now** kills the `caffeinate` child and then runs `pmset sleepnow`, a second
later. Both halves of that are load-bearing. With lid mode on it first switches sleep back on,
since `sleepnow` does nothing while sleep is switched off system-wide. If that fails, it asks
for nothing and the answer says why.

The hold has to go first. `caffeinate -s` outranks `pmset sleepnow`: under a live hold
the Mac drops to DarkWake and stays there, awake in every way that costs power, until the
hold ends by itself. Measured here — `sleepnow` at 23:34:28 produced "Entering DarkWake
state", and the real "Entering Sleep state" landed at 23:40:40, six minutes later, when
caffeinate let go.

The second of delay then serves twice over: it is the head start the reply needs, since
the caller is usually a phone whose connection the suspend is about to kill — and it is
the window the released child needs to actually exit.

The mode itself is left alone and nothing is written down. Sleeping is an act rather than
a mode, so the Mac comes back under the same policy it went under with and the next tick
takes the hold again. That matters more than it looks: a Mac woken by the link, with the
plugin set to Off instead, would get one idle minute before macOS put it straight back.

The tile shows four stages, because this is the one action whose result cannot be
reported by the thing performing it — a suspended Mac does not send a message saying it
suspended, it stops sending messages:

| | |
|---|---|
| **asking** | the request is out. The bar shows a stub rather than a crawl: how long a request takes is the network's business, and a bar that guessed would be inventing progress |
| **going** | answered, and the Mac is counting down its last second. Here the length *is* known — `SLEEP_DELAY_MS` is shared with the server for exactly this — so the bar runs out as the Mac does |
| **asleep** | the status poll stopped being answered. That silence is the only honest confirmation there is |
| **idle** | either it never went, or it came back |

The glyph breathes while the request is in flight and steadies when it is over, so a
phone glanced at across a room still says whether anything is happening.

The phases live in `client/sleep-phase.ts` as a reducer rather than inside the component:
they are the part worth testing, and a plugin surface cannot be rendered under
`node --test`. It is also where the awkward cases are written down — silence with nothing
pending is a closed lid or a switched network and must not be claimed as a sleep; a status
landing mid-countdown is just the five-second poll overlapping the one-second delay; and a
Mac that answers all the way through releases the tile after twenty seconds rather than
leaving it lit for ever.

Waking it is the other half, and it belongs to the network rather than to this plugin.
A sleeping Mac hands its Bonjour-advertised services to a **sleep proxy** — an Apple TV
or a HomePod on the same network. The proxy answers ARP on the Mac's behalf, and when
somebody opens a connection to one of those advertised ports it sends the magic packet
that wakes it. So the plugin advertises one:

- a small web server on port **9999**, which answers the knock with one page: this Mac's
  name, the minute it woke, the battery, and which mode it came back under
- `dns-sd -R … _caffeine-wake._tcp … 9999` beside it, which is what the proxy actually
  sees — a listening socket nobody announced is invisible to that machinery

The page is a receipt, not a service. Everything in it is inline — no fonts, no scripts,
no second request — because whoever is reading it just woke a Mac from a phone that may
have no route anywhere except the VPN it came in on. `no-store`, too: it describes a
moment, and a cached copy of it is a lie the next time the link is pressed.

The link under the tiles is that port at the Mac's own address on the local network.
Copy it once into a shortcut on the phone; pressing it months later wakes the Mac from
outside the house too, as long as you are on the VPN that puts you inside it.

`dns-sd` has no `-w` to tie it to the plugin the way `caffeinate` has, and leaning on a
broken stdout pipe does not work either — it goes quiet after the registration line, so
it never writes into the pipe that would kill it. Two reloads left two live `dns-sd`s
both advertising the same port. So each start reaps the announcements of its own past
lives, matched on the exact command line `announce` builds, before making a new one.

Three things have to be true for any of this to work, and none of them are the plugin's
to arrange: **Wake for network access** on in Energy Saver, the Mac **on the charger**
(Apple ignores network wakes on battery), and a sleep proxy on the network. `pmset -g log`
settles it after the fact — a wake `due to … wifibt` came from the network, one `due to
… HID Activity` came from somebody touching the trackpad.

The header has one button of this plugin's, the lid alert (`client/lid-alert.tsx`). A header
button belongs to one workspace (`PluginHeaderButtonContribution` needs a `workspaceId`), so the
alert is added to every workspace there is. The wake link and Sleep now stay on the page, which
is global.

The battery comes from `pmset -g batt`, parsed rather than computed — `0:00 remaining`
next to `charged` means "not applicable", and `(no estimate)` means pmset is still
working it out. Both read as no estimate rather than as no time left. A machine without
a battery simply has no card.

The watts come from `ioreg -rw0 -c AppleSmartBattery`, read alongside pmset: the charger's
rating from `AdapterDetails`, the power in from `PowerTelemetryData.SystemPowerIn`, and the
battery's flow from its `Voltage` times its `Amperage` (a signed number printed as an
unsigned one). If ioreg fails, the battery still shows, without watts.

The mode lives in `~/.jobby-jobs/caffeine.json` — a fixed path, because a plugin cannot
find its own directory.

Doubt resolves towards staying awake: if the daemon does not answer about agents, the
last answer stands for the same three minutes an idle answer would.

## From ChatGPT, through God Mode

`meta.describe` tells an assistant outside Paseo what this plugin can do, because Paseo
itself hands a remote client nothing but a blind RPC call. It answers in the
`paseo.capabilities/1` shape (`server/capabilities.server.ts`) with everything the page shows
and every change it offers that may be made from afar. Each operation names the real RPC, the
arguments a caller supplies as JSON Schema, the `fixed` arguments the caller cannot change, and
the fields of the answer to read out. "Keep awake" and "let it sleep" are both `caffeine.set`,
with the mode fixed. The schemas are rendered from the same zod contracts the handlers parse
with, so an operation cannot promise an argument its handler would refuse.

| Read | What it answers with |
|---|---|
| `status` (the default) | the mode and its deadline, whether the Mac is held, agents, the display and lid switches, lid mode itself (on, its end, why it ended or who stopped it, the permission), the battery with the charger's watts, the wake link, when it was read |
| `heat` | thermal pressure, the CPU and battery temperatures, each fan's rpm, minimum and maximum and whether another app drives it, the lid, and the heat guard: armed, its state, what fires when, the latch and cool-down, the last trip, its thresholds, dry run and simulation |
| `warmup` | Session warm-up: on or off, the hour, the next and last run, one result per login |
| `everything` | all three in one answer |

| Action | Risk | What it is on the page |
|---|---|---|
| `keep_awake`, `keep_awake_for` (30 min … 12 h) | low | On and the timer; lid mode comes with them when the lid switch is on |
| `auto` | disruptive, asks first | While agents work: the Mac may idle to sleep, and with lid mode on and the lid closed it sleeps at once |
| `allow_sleep` | disruptive, asks first | Off |
| `keep_display` | low | Keep display on |
| `allow_lid_closed` | low | the lid switch on; refused without the one-time permission |
| `stop_lid_closed` | disruptive, asks first | the lid switch off: a closed Mac sleeps at once |
| `lid_back_on` | low | Turn back on, once Sleep now, the header, the battery, heat or a hand ended lid mode |
| `lid_off_now` | disruptive, asks first | the header's alert: sleep back on now, the switch kept |
| `sleep_now` | disruptive, asks first | Sleep now |
| `dismiss_heat_alert` | low | OK on the heat banner |
| `warmup_on` (an hour may come with it) | outward, asks first | Session warm-up on; refused while Settings hides it |
| `warmup_hour` | outward, asks first | − and + on the warm-up tile: the hour moves, on or off stays |
| `warmup_off` | low | Session warm-up off |
| `warmup_now` | outward, asks first | Warm up now; answers at once, and the results come with `warmup` |

**Answers say what happened.** Every change answers with the status after it and two fields
about that one call (`server/actions.server.ts`). `refused` says why nothing was changed, and
God Mode reports it as not done (`outcome`). `problem` says what did not take although the
change was made. Both are read from the system after the change (lid mode from `pmset -g`, the
hold from the caffeinate child), never from what was asked. So the lid switch without the
permission is refused, and On with lid mode that did not come says a closed lid will still sleep
the Mac. Sleep now with sleep still switched off system-wide asks for nothing and says why. Its
answer comes a second before the sleep, so it confirms the request, not the sleep. Warm up now
answers before the warm-up is done, since a plugin RPC times out at 30 s and a warm-up takes
seconds per login.

**Kept back, on purpose** (`NOT_FOR_ASSISTANTS`, each with its reason in the code):

- `caffeine.lid-setup`, the administrator password dialog and the sudoers rule. It needs a person
  at the Mac, and a password prompt raised from afar is a phishing pattern. `lid.setup` says when
  the permission is missing, so ChatGPT can send the person there.
- `settings.preferences.write` and `.reset`: the heat guard's sensitivity and the page's tiles.
  The host stores whatever fits the schema and the plugin's server cannot vet a write, so
  describing them would let a remote caller weaken the guard of a hot Mac with its lid closed.
  `thermal.settings` shows what the guard applies.
- `settings.preferences.read`: nothing an assistant needs that the status does not already say.

No status field is hidden (`HIDDEN_FIELDS` is empty), because nothing in the status is a secret.
The wake link is a LAN address that only wakes the Mac, and warm-up's results name each login by
its email, as the accounts plugin does.

**There is no fan control.** Caffeine reads the fans through its read-only helper (rpm,
minimum, maximum, and whether another app has taken one over). It never sets a speed, so no
operation offers one. The fan popup on the page sets the heat guard's threshold, not the fans.

God Mode reads the description on every call, so a change here reaches ChatGPT with the next
`paseo plugin reload caffeine`, with no God Mode release.

## Definition of Done: ChatGPT sees it too

Caffeine is used from ChatGPT as much as from the page, and ChatGPT can use only what
`meta.describe` declares. So nothing is done until all of this holds for it. That covers every
new feature, RPC, status field and metric, and every new control on the page or in the Command
Center:

1. **Described, or kept back with a reason.** It gets a read or an action in `OPERATIONS`
   (`server/capabilities.server.ts`), or an entry in `NOT_FOR_ASSISTANTS` (an RPC) or
   `HIDDEN_FIELDS` (a status field) that says why not. A new status field also goes into
   `EVERYTHING`, and into the `fields` of every read and action whose answer it belongs to.
2. **Explained.** The operation's `description` says what each field it returns means, with
   units (°C, rpm, watts, RFC 3339) and the values of an enum. God Mode cuts a description at
   600 characters, a title at 80 and the summary at 300.
3. **Its risk decided.** Each risk level has its own rule:
   - `low` is only for what stays on the Mac and is undone with one more call.
   - `outward` is for anything that reaches a service or a person in the user's name.
   - `disruptive` is for anything that can put the Mac to sleep or cut it off: sleep, Off,
     While agents work, lid mode off.

   Anything but `low` gets a `confirmText` that a listener understands: what will happen, no
   field names. Never describe what needs a person at the Mac (the password dialog), what weakens
   the heat guard, or what returns a secret.
4. **Honest.** An action answers with `answer` and works out `refused` and `problem` from the
   status after the change (`server/actions.server.ts`), never from what was asked. When the
   change cannot take, it refuses before changing anything; when part of it does not take, it
   says which part. A call that can outlast the 30 s RPC timeout gets a way to answer at once.
5. **Tested.** `server/capabilities.test.ts` fails on any of these:
   - an RPC or a status field that is neither described nor kept back;
   - a field an operation names that its RPC does not answer with;
   - a field no description explains;
   - an action missing from the risk lists;
   - anything over God Mode's limits.

   The action's verdicts go into `server/actions.test.ts`. `npm test` and `npm run typecheck`
   both pass.
6. **Documented.** The tables above list it.

To see it as ChatGPT will, run `paseo plugin reload caffeine`. Then, from God Mode's
`gpt-site/`, `node core/probe.mjs plugins` shows the catalog and `node core/probe.mjs
plugin-read caffeine heat` shows one read, the way ChatGPT gets them. Nothing in God Mode
changes.

## Things that are the way they are for a reason

**Auto mode needs one request after the daemon starts.** The daemon hands its API to
RPC handlers and nowhere else, so the plugin keeps the most recent one; until a client
has called anything, agents cannot be counted and the surface says it is waiting. Every
connecting client calls `caffeine.get` once for exactly this reason. Verified on the
daemon: the object keeps answering long after the request that carried it.

**The entry point is split, not guarded.** `index.server.ts` loads only on the daemon
and `index.client.tsx` loads only in the app; `server/`, `client/` and `shared/` are
compiler boundaries, so the controller starts unconditionally in `index.server.ts` with
no runtime check for where it is running.

**The wake port is 9999 on purpose.** Browsers refuse a long list of ports outright, 22
and 5900 among them, and the point of this one is that a link to it opens from a phone.
Anything above 1024 also keeps the socket out of root's territory.

**The anchor is not authenticated, and cannot usefully be.** By the time a connection
arrives the Mac is already awake — the proxy woke it to deliver the packet. A secret
checked after that point protects nothing, and the worst anyone within reach of the
network can do with the port is wake a Mac that was asleep.

**The timer is set in minutes, not hours.** Half an hour is the shortest useful hold and
does not fit a whole-hour union, so `setMode` takes `minutes` and the chips render
themselves through the same `formatRemaining` the countdown uses — 30 becomes "30 min",
60 becomes "1 h", with no extra strings in any locale.

**The host's `SettingsSwitch` needs a full-width row.** Given half a phone's width it
wraps the label, wraps the hint, and drops the toggle onto a line of its own — three
ragged lines where the rest of the page has tidy tiles. The display and lid switches are
`ModeCard`s instead, showing "on" the same way a chosen mode does: by the border, with
`MonitorOff`/`Monitor` carrying the display's state and `LaptopMinimal`/`LaptopMinimalCheck`
whether lid mode is on. **Sleep now** is the same tile shape
without a state to show — it borrows the selected look only while the request is in
flight, which on a phone is the last thing rendered before the connection dies. The app ships the whole lucide
set, which is worth checking in
`Contents/Resources/app-dist/_expo/static/js/web/index-*.js` rather than guessing — the
names appear there as `Object.defineProperty(x,"Coffee",…)`.

**A tile's title needs `flex: 1`.** Without it a title wider than the tile runs over the
border instead of wrapping inside it, which only shows up once a title gets long.

**RPC method names are lower case.** The SDK matches them against
`/^[a-z][a-z0-9._-]*$/` and throws `Invalid plugin RPC method` on a capital, at import
time, which takes the whole plugin with it. `caffeine.setDisplay` was refused;
`caffeine.set-display` is the same idea spelled the way the SDK wants.

**Command Center ids start with a letter.** `3h` was refused by the app with "Invalid
Command Center item id", and one bad item takes the whole client contribution down with
it — sidebar entry included — while `paseo plugin ls` still says `running`. The message
appears only in the desktop app's own log, `~/Library/Logs/Paseo/main.log`.

**Tests run the TypeScript sources directly** under `node --test`, which is why relative
imports carry their `.ts` extension and type imports say `import type`. The bundler is
happy either way; Node is not.

**A controller started in a test has to be stopped in it.** `start()` opens an interval,
and `node --test` waits on the handle: one forgotten `stop()` turns a 100 ms file into a
run that only ends when the timeout does.

**The heat guard is tested without heat and without sleep.** `server/thermal.test.ts` drives
the rules with readings and a clock; `server/emergency.test.ts` and `server/heat.test.ts` run
the sequence and the latch against stand-ins; `server/guard.test.ts` runs the guard's real sh
against a pmset, sudo, notifyutil, ioreg and ps that only write down what they were asked (a
"sleepnow" moves a fake clock). The only tests that touch the Mac read it: the guard's and the
helper's readings of this machine's sensors. What still needs a real sleep, and so a person
there to wake it, is the last step: that `pmset sleepnow` sleeps after `disablesleep 0` with the
lid closed, that the wake-and-resleep loop behaves on real wakes, and that a logout switches
sleep back on.
