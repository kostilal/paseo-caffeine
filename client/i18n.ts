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
  /** The lid switch: the timer and On also let the lid close. */
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
  lidFailed(message: string): string;
  /** Session warm-up. `fresh` is when the window would reset, "HH:MM"; `at` when it last ran. */
  warmupLabel: string;
  warmupOn(fresh: string): string;
  warmupOff: string;
  warmupNow: string;
  warmupRunning: string;
  /** Some logins failed, or there were none: `results` says which. */
  warmupLast(at: string, results: string): string;
  /** Every login warmed up. */
  warmupLastOk(at: string): string;
  warmupNone: string;
  /** The Settings screen of its own: its title, and what switching warm-up off there does. */
  settingsTitle: string;
  settingsWarmupHint: string;
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
  /** The power section's heading: where the power comes from. */
  powerAC: string;
  powerBattery: string;
  /** What the charger is rated for, when the Mac does not say what it draws. */
  wattsAdapter(watts: string): string;
  /** The column under the bar: what goes into the battery, and what the Mac itself takes. */
  powerIntoBattery: string;
  powerMac: string;
  /** Off the charger: what the Mac takes from the battery. */
  powerMacDraws(watts: string): string;
  /** Said only once the reading has gone stale; `ago` is a length, "2 min". */
  updated(ago: string): string;
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
  autoDetail: "plus 3 min after",
  hours: (n) => `${n} h`,
  minutes: (n) => `${n} min`,
  displayLabel: "Keep display on",
  displayState: (on) => (on ? "the screen stays lit" : "the screen sleeps"),
  lidLabel: "Lid can close",
  lidOff: "a closed lid sleeps the Mac",
  lidIdle: "works with the timer or On",
  lidOn: (remaining) => `${remaining} left`,
  lidOnNoTimer: "sleep is off outside Caffeine",
  lidOnForever: "until you turn it off",
  lidAlertLabelForever: "Lid · always",
  lidEndedBattery: "turned off: low battery",
  lidEndedHeat: "turned off: running hot",
  lidStoppedSleep: "Sleep now turned it off",
  lidStoppedOff: "turned off from the header",
  lidStoppedManual: "sleep switched back on by hand",
  lidStoppedUnknown: "turned off",
  lidPaused: "a closed lid sleeps the Mac",
  lidResume: "Turn back on",
  lidSetup: "press, the Mac asks for the password",
  lidFailed: (message) => `Did not work: ${message}`,
  warmupLabel: "Session warm-up",
  warmupOn: (fresh) => `window resets at ${fresh}`,
  warmupOff: "starts the 5-hour window early",
  warmupNow: "Warm up now",
  warmupRunning: "Warming up…",
  warmupLast: (at, results) => `last ${at} · ${results}`,
  warmupLastOk: (at) => `last ${at} ✓`,
  warmupNone: "no logged-in accounts",
  settingsTitle: "Settings",
  settingsWarmupHint: "Off: no tile on the page, and no warm-up runs.",
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
  powerAC: "On the charger",
  powerBattery: "On battery",
  wattsAdapter: (watts) => `charger ${watts}`,
  powerIntoBattery: "Into the battery",
  powerMac: "The Mac itself",
  powerMacDraws: (watts) => `the Mac draws ${watts}`,
  updated: (ago) => `updated ${ago} ago`,
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
  autoDetail: "и ещё 3 мин после",
  hours: (n) => `${n} ч`,
  minutes: (n) => `${n} мин`,
  displayLabel: "Не гасить экран",
  displayState: (on) => (on ? "экран не гаснет" : "экран гаснет как обычно"),
  lidLabel: "Можно закрыть крышку",
  lidOff: "крышка усыпляет Mac",
  lidIdle: "работает с таймером или Вкл",
  lidOn: (remaining) => `осталось ${remaining}`,
  lidOnNoTimer: "сон выключен не Caffeine",
  lidOnForever: "пока не выключишь",
  lidAlertLabelForever: "Крышка · всегда",
  lidEndedBattery: "выключился: низкий заряд",
  lidEndedHeat: "выключился: перегрев",
  lidStoppedSleep: "«Усыпить» выключил",
  lidStoppedOff: "выключили в шапке",
  lidStoppedManual: "сон включили вручную",
  lidStoppedUnknown: "выключен",
  lidPaused: "крышка усыпит Mac",
  lidResume: "Включить снова",
  lidSetup: "нажми, Mac спросит пароль",
  lidFailed: (message) => `Не вышло: ${message}`,
  warmupLabel: "Прогрев сессии",
  warmupOn: (fresh) => `сброс окна в ${fresh}`,
  warmupOff: "заранее запускает 5-часовое окно",
  warmupNow: "Прогреть сейчас",
  warmupRunning: "Прогреваю…",
  warmupLast: (at, results) => `последний ${at} · ${results}`,
  warmupLastOk: (at) => `последний ${at} ✓`,
  warmupNone: "нет аккаунтов со входом",
  settingsTitle: "Настройки",
  settingsWarmupHint: "Выключено: карточки нет, прогрев не запускается.",
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
  powerAC: "От сети",
  powerBattery: "От батареи",
  wattsAdapter: (watts) => `блок ${watts}`,
  powerIntoBattery: "В батарею",
  powerMac: "Сам Mac",
  powerMacDraws: (watts) => `Mac берёт ${watts}`,
  updated: (ago) => `обновлено ${ago} назад`,
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
  autoDetail: "і ще 3 хв після",
  hours: (n) => `${n} год`,
  minutes: (n) => `${n} хв`,
  displayLabel: "Не гасити екран",
  displayState: (on) => (on ? "екран не гасне" : "екран гасне як завжди"),
  lidLabel: "Можна закрити кришку",
  lidOff: "кришка присипляє Mac",
  lidIdle: "працює з таймером або Увімк",
  lidOn: (remaining) => `лишилось ${remaining}`,
  lidOnNoTimer: "сон вимкнено не Caffeine",
  lidOnForever: "поки не вимкнеш",
  lidAlertLabelForever: "Кришка · завжди",
  lidEndedBattery: "вимкнувся: низький заряд",
  lidEndedHeat: "вимкнувся: перегрів",
  lidStoppedSleep: "«Приспати» вимкнув",
  lidStoppedOff: "вимкнули в шапці",
  lidStoppedManual: "сон увімкнули вручну",
  lidStoppedUnknown: "вимкнено",
  lidPaused: "кришка приспить Mac",
  lidResume: "Увімкнути знову",
  lidSetup: "натисни, Mac спитає пароль",
  lidFailed: (message) => `Не вийшло: ${message}`,
  warmupLabel: "Прогрів сесії",
  warmupOn: (fresh) => `скидання вікна о ${fresh}`,
  warmupOff: "заздалегідь запускає 5-годинне вікно",
  warmupNow: "Прогріти зараз",
  warmupRunning: "Прогріваю…",
  warmupLast: (at, results) => `останній ${at} · ${results}`,
  warmupLastOk: (at) => `останній ${at} ✓`,
  warmupNone: "немає акаунтів із входом",
  settingsTitle: "Налаштування",
  settingsWarmupHint: "Вимкнено: картки немає, прогрів не запускається.",
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
  powerAC: "Від мережі",
  powerBattery: "Від батареї",
  wattsAdapter: (watts) => `блок ${watts}`,
  powerIntoBattery: "У батарею",
  powerMac: "Сам Mac",
  powerMacDraws: (watts) => `Mac бере ${watts}`,
  updated: (ago) => `оновлено ${ago} тому`,
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
