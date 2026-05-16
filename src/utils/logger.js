/**
 * Simple logger with timestamp and level
 */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS.INFO;

function timestamp() {
  return new Date().toISOString();
}

function formatMsg(level, ...args) {
  return `[${timestamp()}] [${level}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : a)).join(' ')}`;
}

const logger = {
  debug(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.DEBUG) console.log(formatMsg('DEBUG', ...args));
  },
  info(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.INFO) console.log(formatMsg('INFO', ...args));
  },
  warn(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.WARN) console.warn(formatMsg('WARN', ...args));
  },
  error(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.ERROR) console.error(formatMsg('ERROR', ...args));
  },
};

module.exports = logger;
