const { FuzzedDataProvider } = require('@jazzer.js/core');
const RawTimer = require('./dist/timer.cjs');
const Timer = RawTimer.default || RawTimer;

const CRON_PATTERNS = [
  '* * * * *',
  '*/5 * * * *',
  '0 0 * * *',
  '30 14 1 1 *',
  '0 12 * * 1-5',
  'invalid cron pattern'
];

const TIMEZONES = [
  'UTC',
  'Europe/Prague',
  'America/New_York',
  'Asia/Tokyo',
  'Invalid/Timezone'
];

module.exports.fuzz = function(data) {
  let timer;
  try {
    const provider = new FuzzedDataProvider(data);
    
    const tz = provider.pickValue(TIMEZONES);
    const hasRetry = provider.consumeBoolean();
    const retry = hasRetry
      ? {
          attempts: provider.consumeIntegralInRange(1, 5),
          delay: provider.consumeIntegralInRange(10, 1000),
          backoff: provider.consumeBoolean() ? 'exponential' : 'constant'
        }
      : undefined;

    timer = new Timer('fuzz-timer', { timezone: tz, retry });

    const numOperations = provider.consumeIntegralInRange(1, 20);

    for (let i = 0; i < numOperations; i++) {
      const op = provider.consumeIntegralInRange(0, 11);
      const taskId = 'task_' + provider.consumeIntegralInRange(0, 10);

      switch (op) {
        case 0: {
          // set with timestamp/number
          const delay = provider.consumeIntegralInRange(1, 100000);
          const interval = provider.consumeBoolean() ? provider.consumeIntegralInRange(100, 5000) : undefined;
          timer.set(taskId, delay, () => {}, { interval, data: provider.consumeString(10) });
          break;
        }
        case 1: {
          // set with cron string
          const cronExpr = provider.pickValue(CRON_PATTERNS);
          try {
            timer.set(taskId, cronExpr, () => {}, { data: provider.consumeString(10) });
          } catch (e) {
            // Expected for invalid cron strings or unsupported options
          }
          break;
        }
        case 2: {
          // set with Date
          const futureDate = new Date(Date.now() + provider.consumeIntegralInRange(1000, 60000));
          timer.set(taskId, futureDate, () => {});
          break;
        }
        case 3:
          timer.postpone(taskId, provider.consumeIntegralInRange(100, 5000));
          break;
        case 4:
          timer.pause(taskId);
          break;
        case 5:
          timer.resume(taskId);
          break;
        case 6:
          timer.unset(taskId);
          break;
        case 7:
          timer.has(taskId);
          break;
        case 8:
          timer.ids();
          break;
        case 9:
          timer.id('prefix_');
          Timer.id('static_');
          break;
        case 10:
          if (provider.consumeBoolean()) {
            Timer.pause();
          } else {
            Timer.resume();
          }
          break;
        case 11:
          timer.clear();
          break;
      }
    }
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) {
      return;
    }
    throw e;
  } finally {
    if (timer) {
      try {
        timer.destroy();
      } catch (e) {
        // ignore cleanup error
      }
    }
    try {
      Timer.resume();
    } catch (e) {
      // ignore cleanup error
    }
  }
};
