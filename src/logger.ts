const ts = () => new Date().toISOString();

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`${ts()} [info] ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`${ts()} [warn] ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`${ts()} [error] ${msg}`, ...rest),
  debug: (enabled: boolean, msg: string, ...rest: unknown[]) => {
    if (enabled) console.log(`${ts()} [debug] ${msg}`, ...rest);
  },
};
