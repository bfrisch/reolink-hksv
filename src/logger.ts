/** ISO-8601 timestamp prefixed onto every log line. */
const ts = () => new Date().toISOString();

/** Timestamped console logger. Debug lines are printed only when explicitly enabled. */
export const log = {
  /** Informational line. Extra values are forwarded to `console.log`. */
  info: (msg: string, ...rest: unknown[]) => console.log(`${ts()} [info] ${msg}`, ...rest),
  /** Warning line. Extra values are forwarded to `console.warn`. */
  warn: (msg: string, ...rest: unknown[]) => console.warn(`${ts()} [warn] ${msg}`, ...rest),
  /** Error line. Extra values are forwarded to `console.error`. */
  error: (msg: string, ...rest: unknown[]) => console.error(`${ts()} [error] ${msg}`, ...rest),
  /**
   * Debug line, emitted only when `enabled` is true.
   *
   * @param enabled - whether this call should print
   * @param msg - message text
   * @param rest - extra values forwarded to `console.log`
   */
  debug: (enabled: boolean, msg: string, ...rest: unknown[]) => {
    if (enabled) console.log(`${ts()} [debug] ${msg}`, ...rest);
  },
};
