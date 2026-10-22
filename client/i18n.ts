export type Locale = "en" | "ru" | "uk";

export interface Strings {
  sidebarTitle: string;
  title: string;
  tagline: string;
  taglineDetail(keepDisplay: boolean): string;
  stateAwake: string;
  stateAsleep: string;
  remaining(remaining: string): string;
  agentsRunning(agents: number): string;
  agentsIdle: string;
  agentsWaiting: string;
  untilOff: string;
  modeLabel: string;
  off: string;
  offDetail: string;
  on: string;
  onDetail: string;
  /** On with the lid switch on. */
  onDetailLid: string;
  timer: string;
  timerDetail: string;
  auto: string;
  autoDetail: string;
  hours(n: number): string;
  minutes(n: number): string;
  displayLabel: string;
  displayState(on: boolean): string;
  /** The timer's lid switch: the timer and On also let the lid close. */
  lidLabel: string;
  lidOff: string;
  /** The switch is on, and neither the timer nor On is running. */
  lidIdle: string;
  lidOn(remaining: string): string;
  lidOnNoTimer: string;
  /** Lid mode with no end, under On: the tile's line and the header label. */
  lidOnForever: string;
  lidAlertLabelForever: string;
  lidEndedBattery: string;
  lidEndedHeat: string;
  /** Lid mode off while the switch is on and a timer or On runs: who did it, then the tail. */
  lidStoppedSleep: string;
  lidStoppedOff: string;
  lidStoppedManual: string;
  lidStoppedUnknown: string;
  lidPaused: string;
  lidResume: string;
  lidSetup: string;
  lidSetupButton: string;
  lidFailed(message: string): string;
  /** Session warm-up. `time` is "HH:MM"; `fresh` is when the window would reset. */
  warmupLabel: string;
  warmupOn(time: string, fresh: string): string;
  warmupOff: string;
  warmupEnable: string;
  warmupDisable: string;
  warmupNow: string;
  warmupRunning: string;
  warmupLast(at: string, results: string): string;
  warmupNone: string;
  /** The header alert while lid mode is on. */
  lidAlertTitle: string;
  lidAlertLabel(remaining: string): string;
  lidAlertLabelNoTimer: string;
  sleepLabel: string;
  sleepDetail: string;
  /** The tile's own three stages, and what it is called once the Mac has gone. */
  sleepAsking: string;
  sleepGoing: string;
  sleptLabel: string;
  sleepAsleep: string;
  wakeHint: string;
  wakeMissing: string;
  batteryCharged: string;
  batteryUntilFull(eta: string): string;
  batteryUntilEmpty(eta: string): string;
  batteryNoEstimate: string;
  powerAC: string;
  powerBattery: string;
  /** What the charger is rated for, and what of it goes into the battery. */
  wattsAdapter(watts: string): string;
  wattsIntoBattery(watts: string): string;
  updated(secondsAgo: number): string;
  errorPrefix: string;
  /** The Command Center rows. Each one carries the plugin's name, because ⌘K is a flat
   *  list of everything and "Off" on its own belongs to nothing. */
  commandOff: string;
  commandOn: string;
  commandTimer(hours: number): string;
  commandAuto: string;
  commandDisplayOn: string;
  commandDisplayOff: string;
}

const en: Strings = {
  sidebarTitle: "Caffeine",
  title: "Caffeine",
  tagline: "Keeps the Mac awake for your agents.",
  taglineDetail: (keepDisplay) => (keepDisplay ? "System sleep and the display are both held." : "Only system sleep is held; the display goes dark as usual."),
  stateAwake: "AWAKE",
  stateAsleep: "SLEEPS AS USUAL",
  remaining: (remaining) => `${remaining} left`,
  agentsRunning: (agents) => `${agents} agent${agents === 1 ? "" : "s"} running`,
  agentsIdle: "no agents running",
  agentsWaiting: "waiting for the daemon",
  untilOff: "until you turn it off",
  modeLabel: "Mode",
  off: "Off",
  offDetail: "macOS decides",
  on: "On",
  onDetail: "until you turn it off",
  onDetailLid: "no end, lid can close",
  timer: "Timer",
  timerDetail: "then back to Off by itself",
  auto: "While agents work",
  autoDetail: "releases three minutes after the last agent goes quiet",
  hours: (n) => `${n} h`,
  minutes: (n) => `${n} min`,
  displayLabel: "Keep display on",
  displayState: (on) => (on ? "the screen stays lit" : "the screen sleeps"),
  lidLabel: "Lid can close",
  lidOff: "A closed lid sleeps the Mac. Switch on to keep it running with the lid shut for the timer, or under On.",
  lidIdle: "Pick a timer or On: the lid can close for as long as it lasts.",
  lidOn: (remaining) => `You can close the lid · ${remaining} left. Sleep comes back by itself.`,
  lidOnNoTimer: "Sleep is switched off on this Mac outside Caffeine.",
  lidOnForever: "You can close the lid, with no end. Another mode, the switch or the header turns it off; so do a low battery and heat.",
  lidAlertLabelForever: "Lid · always",
  lidEndedBattery: "Turned off by itself: the battery was low.",
  lidEndedHeat: "Turned off by itself: the Mac was running hot.",
  lidStoppedSleep: "Turned off by Sleep now.",
  lidStoppedOff: "Turned off from the header.",
  lidStoppedManual: "Sleep was switched back on outside Caffeine.",
  lidStoppedUnknown: "Lid mode is off.",
  lidPaused: "A closed lid sleeps the Mac now.",
  lidResume: "Turn back on",
  lidSetup: "Needs a one-time permission on the Mac: it allows only this one power setting.",
  lidSetupButton: "Allow on this Mac",
  lidFailed: (message) => `Did not work: ${message}`,
  warmupLabel: "Session warm-up",
  warmupOn: (time, fresh) => `Every day at ${time} one short Haiku message per Claude account starts its 5-hour window, so it resets at ${fresh}. Only while the Mac is awake.`,
  warmupOff: "Off. Start each account's 5-hour window early, so it resets partway into your day.",
  warmupEnable: "Turn on",
  warmupDisable: "Turn off",
  warmupNow: "Warm up now",
  warmupRunning: "Warming up…",
  warmupLast: (at, results) => `Last: ${at} · ${results}`,
  warmupNone: "no logged-in accounts",
  lidAlertTitle: "Lid mode is on: this Mac will not sleep. Press to turn it off",
  lidAlertLabel: (remaining) => `Lid · ${remaining}`,
  lidAlertLabelNoTimer: "Lid · no sleep",
  sleepLabel: "Sleep now",
  sleepDetail: "goes under in a second",
  sleepAsking: "asking the Mac…",
  sleepGoing: "going under now…",
  sleptLabel: "Asleep",
  sleepAsleep: "it stopped answering",
  wakeHint: "To wake it up, use this link",
  wakeMissing: "no address to wake by yet",
  batteryCharged: "charged",
  batteryUntilFull: (eta) => `full in ${eta}`,
  batteryUntilEmpty: (eta) => `${eta} left`,
  batteryNoEstimate: "working out the estimate",
  powerAC: "on the charger",
  powerBattery: "on battery",
  wattsAdapter: (watts) => `charger ${watts}`,
  wattsIntoBattery: (watts) => `into the battery ${watts}`,
  updated: (s) => (s < 5 ? "updated just now" : `updated ${s} s ago`),
  errorPrefix: "caffeinate failed",
  commandOff: "Caffeine: off",
  commandOn: "Caffeine: on",
  commandTimer: (hours) => `Caffeine: ${hours} hours`,
  commandAuto: "Caffeine: while agents work",
  commandDisplayOn: "Caffeine: keep the display on",
  commandDisplayOff: "Caffeine: let the display sleep",
};

const ru: Strings = {
  sidebarTitle: "Кофеин",
  title: "Кофеин",
  tagline: "Не даёт Mac уснуть, пока работают агенты.",
  taglineDetail: (keepDisplay) => (keepDisplay ? "Держим и систему, и экран." : "Только сон системы: экран гаснет как обычно."),
  stateAwake: "НЕ СПИТ",
  stateAsleep: "СПИТ КАК ОБЫЧНО",
  remaining: (remaining) => `осталось ${remaining}`,
  agentsRunning: (agents) => `работает агентов: ${agents}`,
  agentsIdle: "агенты не работают",
  agentsWaiting: "жду ответа демона",
  untilOff: "пока не выключишь",
  modeLabel: "Режим",
  off: "Выкл",
  offDetail: "решает macOS",
  on: "Вкл",
  onDetail: "пока не выключишь",
  onDetailLid: "без конца, можно с крышкой",
  timer: "Таймер",
  timerDetail: "потом сам вернётся в Выкл",
  auto: "Пока работают агенты",
  autoDetail: "отпускает через три минуты после последнего агента",
  hours: (n) => `${n} ч`,
  minutes: (n) => `${n} мин`,
  displayLabel: "Не гасить экран",
  displayState: (on) => (on ? "экран не гаснет" : "экран гаснет как обычно"),
  lidLabel: "Можно закрыть крышку",
  lidOff: "С закрытой крышкой Mac засыпает. Включи, чтобы он работал с закрытой крышкой на время таймера или в режиме Вкл.",
  lidIdle: "Выбери таймер или Вкл: крышку можно закрыть, пока он идёт.",
  lidOn: (remaining) => `Можно закрывать крышку · осталось ${remaining}. Сон вернётся сам.`,
  lidOnNoTimer: "Сон на этом Mac выключен не через Caffeine.",
  lidOnForever: "Можно закрывать крышку, без ограничения по времени. Выключит другой режим, переключатель или кнопка в шапке; а также низкий заряд и перегрев.",
  lidAlertLabelForever: "Крышка · всегда",
  lidEndedBattery: "Выключился сам: был низкий заряд.",
  lidEndedHeat: "Выключился сам: Mac перегревался.",
  lidStoppedSleep: "Выключено кнопкой «Усыпить».",
  lidStoppedOff: "Выключено кнопкой в шапке.",
  lidStoppedManual: "Сон включили обратно не через Caffeine.",
  lidStoppedUnknown: "Режим крышки выключен.",
  lidPaused: "Сейчас закрытая крышка усыпит Mac.",
  lidResume: "Включить снова",
  lidSetup: "Нужно один раз разрешить на Mac: это разрешает только эту одну настройку питания.",
  lidSetupButton: "Разрешить на этом Mac",
  lidFailed: (message) => `Не вышло: ${message}`,
  warmupLabel: "Прогрев сессии",
  warmupOn: (time, fresh) => `Каждый день в ${time} одно короткое сообщение Haiku на каждый аккаунт Claude запускает его 5-часовое окно, и оно сбросится в ${fresh}. Только пока Mac не спит.`,
  warmupOff: "Выключен. Запускает 5-часовое окно каждого аккаунта заранее, чтобы оно сбросилось посреди рабочего дня.",
  warmupEnable: "Включить",
  warmupDisable: "Выключить",
  warmupNow: "Прогреть сейчас",
  warmupRunning: "Прогреваю…",
  warmupLast: (at, results) => `Последний: ${at} · ${results}`,
  warmupNone: "нет аккаунтов со входом",
  lidAlertTitle: "Режим крышки включён: Mac не заснёт. Нажми, чтобы выключить",
  lidAlertLabel: (remaining) => `Крышка · ${remaining}`,
  lidAlertLabelNoTimer: "Крышка · без сна",
  sleepLabel: "Усыпить",
  sleepDetail: "уснёт через секунду",
  sleepAsking: "прошу мак…",
  sleepGoing: "засыпает…",
  sleptLabel: "Спит",
  sleepAsleep: "перестал отвечать",
  wakeHint: "Чтобы разбудить, открой эту ссылку",
  wakeMissing: "адреса пока нет",
  batteryCharged: "заряжена",
  batteryUntilFull: (eta) => `полная через ${eta}`,
  batteryUntilEmpty: (eta) => `хватит на ${eta}`,
  batteryNoEstimate: "считает оценку",
  powerAC: "от сети",
  powerBattery: "от батареи",
  wattsAdapter: (watts) => `блок ${watts}`,
  wattsIntoBattery: (watts) => `в батарею ${watts}`,
  updated: (s) => (s < 5 ? "обновлено только что" : `обновлено ${s} с назад`),
  errorPrefix: "caffeinate не запустился",
  commandOff: "Caffeine: выключить",
  commandOn: "Caffeine: включить",
  commandTimer: (hours) => `Caffeine: на ${hours} часа`,
  commandAuto: "Caffeine: пока работают агенты",
  commandDisplayOn: "Caffeine: не гасить экран",
  commandDisplayOff: "Caffeine: разрешить гасить экран",
};

const uk: Strings = {
  sidebarTitle: "Кофеїн",
  title: "Кофеїн",
  tagline: "Не дає Mac заснути, доки працюють агенти.",
  taglineDetail: (keepDisplay) => (keepDisplay ? "Тримаємо і систему, і екран." : "Лише сон системи: екран гасне як зазвичай."),
  stateAwake: "НЕ СПИТЬ",
  stateAsleep: "СПИТЬ ЯК ЗАЗВИЧАЙ",
  remaining: (remaining) => `залишилось ${remaining}`,
  agentsRunning: (agents) => `працює агентів: ${agents}`,
  agentsIdle: "агенти не працюють",
  agentsWaiting: "чекаю відповіді демона",
  untilOff: "доки не вимкнеш",
  modeLabel: "Режим",
  off: "Вимк",
  offDetail: "вирішує macOS",
  on: "Увімк",
  onDetail: "доки не вимкнеш",
  onDetailLid: "без кінця, можна з кришкою",
  timer: "Таймер",
  timerDetail: "потім сам повернеться у Вимк",
  auto: "Доки працюють агенти",
  autoDetail: "відпускає через три хвилини після останнього агента",
  hours: (n) => `${n} год`,
  minutes: (n) => `${n} хв`,
  displayLabel: "Не гасити екран",
  displayState: (on) => (on ? "екран не гасне" : "екран гасне як завжди"),
  lidLabel: "Можна закрити кришку",
  lidOff: "Із закритою кришкою Mac засинає. Увімкни, щоб він працював із закритою кришкою на час таймера або в режимі Увімк.",
  lidIdle: "Обери таймер або Увімк: кришку можна закрити, поки він триває.",
  lidOn: (remaining) => `Можна закривати кришку · лишилось ${remaining}. Сон повернеться сам.`,
  lidOnNoTimer: "Сон на цьому Mac вимкнено не через Caffeine.",
  lidOnForever: "Можна закривати кришку, без обмеження в часі. Вимкне інший режим, перемикач або кнопка в шапці; а також низький заряд і перегрів.",
  lidAlertLabelForever: "Кришка · завжди",
  lidEndedBattery: "Вимкнувся сам: був низький заряд.",
  lidEndedHeat: "Вимкнувся сам: Mac перегрівався.",
  lidStoppedSleep: "Вимкнено кнопкою «Приспати».",
  lidStoppedOff: "Вимкнено кнопкою в шапці.",
  lidStoppedManual: "Сон увімкнули назад не через Caffeine.",
  lidStoppedUnknown: "Режим кришки вимкнено.",
  lidPaused: "Зараз закрита кришка приспить Mac.",
  lidResume: "Увімкнути знову",
  lidSetup: "Потрібно один раз дозволити на Mac: це дозволяє лише одне налаштування живлення.",
  lidSetupButton: "Дозволити на цьому Mac",
  lidFailed: (message) => `Не вийшло: ${message}`,
  warmupLabel: "Прогрів сесії",
  warmupOn: (time, fresh) => `Щодня о ${time} одне коротке повідомлення Haiku на кожен акаунт Claude запускає його 5-годинне вікно, і воно скинеться о ${fresh}. Лише поки Mac не спить.`,
  warmupOff: "Вимкнено. Запускає 5-годинне вікно кожного акаунта заздалегідь, щоб воно скинулось посеред робочого дня.",
  warmupEnable: "Увімкнути",
  warmupDisable: "Вимкнути",
  warmupNow: "Прогріти зараз",
  warmupRunning: "Прогріваю…",
  warmupLast: (at, results) => `Останній: ${at} · ${results}`,
  warmupNone: "немає акаунтів із входом",
  lidAlertTitle: "Режим кришки ввімкнено: Mac не засне. Натисни, щоб вимкнути",
  lidAlertLabel: (remaining) => `Кришка · ${remaining}`,
  lidAlertLabelNoTimer: "Кришка · без сну",
  sleepLabel: "Приспати",
  sleepDetail: "засне за секунду",
  sleepAsking: "прошу мак…",
  sleepGoing: "засинає…",
  sleptLabel: "Спить",
  sleepAsleep: "перестав відповідати",
  wakeHint: "Щоб розбудити, відкрий це посилання",
  wakeMissing: "адреси поки немає",
  batteryCharged: "заряджена",
  batteryUntilFull: (eta) => `повна через ${eta}`,
  batteryUntilEmpty: (eta) => `вистачить на ${eta}`,
  batteryNoEstimate: "рахує оцінку",
  powerAC: "від мережі",
  powerBattery: "від батареї",
  wattsAdapter: (watts) => `блок ${watts}`,
  wattsIntoBattery: (watts) => `у батарею ${watts}`,
  updated: (s) => (s < 5 ? "оновлено щойно" : `оновлено ${s} с тому`),
  errorPrefix: "caffeinate не запустився",
  commandOff: "Caffeine: вимкнути",
  commandOn: "Caffeine: увімкнути",
  commandTimer: (hours) => `Caffeine: на ${hours} години`,
  commandAuto: "Caffeine: доки працюють агенти",
  commandDisplayOn: "Caffeine: не гасити екран",
  commandDisplayOff: "Caffeine: дозволити гасити екран",
};

const catalogue: Record<Locale, Strings> = { en, ru, uk };

export function resolveLocale(tag: string): Locale {
  const lower = tag.toLowerCase();
  if (lower.startsWith("uk")) return "uk";
  if (lower.startsWith("ru")) return "ru";
  return "en";
}

/** The device's language: what the daemon-side title uses, and the fallback everywhere. */
export function detectLocale(): Locale {
  try {
    return resolveLocale(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
}

/**
 * The language chosen in Paseo's own settings, when it can be read.
 *
 * The plugin SDK does not hand a surface the app's language, but on the desktop and the
 * web the plugin runs in the same window as Paseo, whose settings live in localStorage as
 * one JSON record carrying `language` and `theme`. The record is found by shape rather
 * than by key, so a renamed key degrades to the device language instead of breaking.
 * "system" means the device language; the phone has no localStorage and gets the same.
 */
export function detectAppLocale(): Locale {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const raw = key ? storage.getItem(key) : null;
        if (!raw || raw[0] !== "{" || !raw.includes('"language"')) continue;
        const parsed = JSON.parse(raw) as { language?: unknown; theme?: unknown };
        if (typeof parsed.language !== "string" || !("theme" in parsed)) continue;
        if (parsed.language === "system") break;
        return resolveLocale(parsed.language);
      }
    }
  } catch {
    // Storage may be absent, blocked, or hold something that is not JSON; the device
    // language is the right answer in every one of those cases.
  }
  return detectLocale();
}

export function t(locale: Locale = detectLocale()): Strings {
  return catalogue[locale];
}

/** "2 h 40 min" from milliseconds; never negative, never empty. */
export function formatRemaining(ms: number, strings: Strings): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return strings.minutes(m);
  if (m === 0) return strings.hours(h);
  return `${strings.hours(h)} ${strings.minutes(m)}`;
}
