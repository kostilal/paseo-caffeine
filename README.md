# Caffeine

A switch for the Mac's sleep, inside [Paseo](https://getpaseo.com): on the desktop,
on the phone, and per host when several are connected.

Agents keep working after you walk away; a MacBook on battery does not. Until now the
machine stayed awake only because Orca ran `caffeinate` underneath itself. This plugin
gives Paseo the same lever with three positions:

| | |
|---|---|
| **On** | The Mac does not sleep until you say otherwise. Survives a daemon restart. With the lid switch on, the lid can close too, with no end. |
| **30 min … 12 h** | The Mac does not sleep until the deadline, then the switch goes back to Off by itself. Six lengths: 30 min, 1 h, 2 h, 3 h, 8 h, 12 h. With the lid switch on, the lid can close until the same deadline. |
| **While agents work** | The Mac does not sleep while at least one Paseo agent on this host is running, and for three minutes after the last one went quiet. |

Off, On and **Sleep now**, which sends the Mac under from wherever you are, share the top
row; **Keep display on** sits next to While agents work. Below the modes is the link that
wakes the Mac again.

Only system sleep is held and the display sleeps as usual — unless **Keep display on** is
switched on, which holds both whenever the Mac is held. A closed lid still sleeps a MacBook,
`caffeinate` or not.

**Lid can close**, the switch on the timer, is the one exception to that. With it on, the
timer lets the Mac run with the lid shut until its deadline, and On lets it run with no end;
Off and While agents work turn lid mode off, and the switch stays as it was for next time.
It flips the system's own `pmset disablesleep`, which needs root, so the first press offers
**Allow on this Mac**: macOS asks for the password (or Touch
ID) once, and a sudoers rule allowing exactly `pmset -a disablesleep 1` and `… 0`, checked
with `visudo` first, goes into `/etc/sudoers.d/paseo-caffeine`. After that the switch works
from the phone too. Sleep comes back by itself at the deadline, on battery below 20%, and
before **Sleep now**. A guard does the same even if Paseo is not running by then: a
LaunchAgent (`~/Library/LaunchAgents/com.paseo.caffeine.lid-guard.plist`) that waits for the
deadline, restores sleep (retrying for up to half an hour until `pmset -g` confirms it) and
removes itself; after a reboot it runs again at login. macOS may announce it as a new
background item (shown as `sh` in System Settings → General → Login Items); switched off
there, lid mode refuses to start, since nothing would bring sleep back. Caffeine only lets
go of the deadline once `pmset -g` confirms sleep is back, so a failed attempt is retried.
Under **On** lid mode has no end and no guard: it lasts until you turn it off (another mode,
the switch, the header, or Sleep now), the battery drops below 20% off the charger, or macOS
reports the Mac running hot (`pmset -g therm`). The heat check applies under the timer too.
Lid mode that ended on a low battery or heat, or was turned off by Sleep now, the header
or by hand, stays off until you ask for it again: while the switch is on and a timer or On
runs, the card says who turned it off and that a closed lid now sleeps the Mac, next to
**Turn back on**, which picks lid mode up for the rest of the timer (or with no end under On).
While lid mode is on, closing the lid puts the screen to sleep (`pmset displaysleepnow`,
checked once a minute while the lid stays shut, so a panel woken under a closed lid goes dark
again; not with an external monitor attached, which it would blank too (also one plugged in after the lid closed); with Screen Sharing into a closed Mac the shared
screen goes dark every minute too). Lid mode switches sleep off system-wide. Battery and heat
are watched only while Paseo runs; with Paseo closed, lid mode under On stays on until you turn it off
(macOS's own low-battery and thermal shutdowns still apply). By hand: `sudo pmset -a
disablesleep 0`. To undo the permission: `sudo rm /etc/sudoers.d/paseo-caffeine`.

The surface also shows the Mac's own battery: charge, whether the charger is in, and how
long the charge has left — or how long until it is full. On the charger it also shows the
watts, the way Wattage Connected does: what the Mac is drawing now next to the charge, and
what the charger is rated for and how much goes into the battery underneath.

## Installing it

```sh
npm install
paseo plugin install ./paseo-caffeine      # once
paseo plugin reload caffeine               # after every change
```

Then **Caffeine** in the sidebar, or ⌘K and type "caffeine".

## How it works

The server half runs `caffeinate -i -s -w <its own pid>` as a child process while the
policy says so, and re-evaluates every thirty seconds: it asks the daemon how many agents
are running, reads the battery, moves a busy window, and starts or stops the child. `-w`
ties the child to the plugin, so a plugin killed without cleanup takes its `caffeinate`
down with it. Timer holds add `-t` as a second guard, and **Keep display on** adds `-d`.

**Keep display on** and **Lid can close** ride on their own RPC that takes a patch, rather
than on the mode: the display is a property of the machine you sit at, and the lid switch
says what the timer and On mean, not which of them runs. Both survive a mode change and a
spent timer alike. The controller turns lid mode on and off to match only when a person
changes the mode or the switch, never on a tick.

## Sleeping, and getting back

**Sleep now** kills the `caffeinate` child and then runs `pmset sleepnow`, a second
later. Both halves of that are load-bearing.

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

A header button would have been an obvious third place for all this and is not available —
`PluginHeaderButtonContribution` needs a `workspaceId`, and this surface is global.

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
itself hands a remote client nothing but a blind RPC call. It answers with seven operations
in the `paseo.capabilities/1` shape: the status, and the actions behind the tiles. Each one
names the real RPC, the arguments a caller supplies as JSON Schema, and `fixed` arguments
the caller cannot change. "Keep awake" and "let it sleep" are both `caffeine.set`, with the
mode fixed. Letting the Mac sleep and sleeping now are marked `disruptive` and are
confirmed with the user first: an asleep Mac pauses its agents and cannot be reached.

The schemas are rendered from the same zod contracts the handlers parse with
(`server/capabilities.server.ts`), and the tests prove each operation's arguments,
merged under its fixed ones, pass the handler's own contract.

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
ragged lines where the rest of the page has tidy tiles. The display toggle is a
`ModeCard` instead, showing "on" the same way a chosen mode does: by the border, with
`MonitorOff`/`Monitor` carrying the state as well. The lid switch is a chip inside the
timer's card, showing "on" the same way a chosen length does. **Sleep now** is the same tile shape
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
