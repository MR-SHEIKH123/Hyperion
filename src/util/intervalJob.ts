/**
 * The recurring-background-job primitive.
 *
 * `startCleanupScheduler` established this shape and two more jobs now need it
 * (the daily backup, and the Cowork scheduled-task runner), so the mechanics
 * live here once instead of being copied a third time. Every property of that
 * original is load-bearing and preserved:
 *
 *   - **Both timers are unref'd.** A pending job must never be the reason the
 *     process stays alive during shutdown.
 *   - **It runs shortly after boot, not only on the interval.** A machine that
 *     gets rebooted daily would otherwise never reach a 24h tick, so the job
 *     would appear to work and in fact never run.
 *   - **A thrown tick is logged, not propagated.** These run detached from any
 *     request, so an unhandled rejection here would take the server down for a
 *     failure that only needed to be retried on the next tick.
 *   - **Starting twice is a no-op.** Two intervals doing the same sweep is a
 *     bug that hides for a long time.
 *
 * Ticks are also serialised per job: a run that overruns its own interval
 * delays the next one rather than overlapping with itself, which for a database
 * backup or an agent run is the difference between slow and corrupt.
 */

import { createLogger } from './logger.ts';

export interface IntervalJobOptions {
  /** Used for log lines, so make it read like a thing rather than a function. */
  name: string;
  /** How often to run once the boot tick is out of the way. */
  intervalMs: number;
  /**
   * Grace period before the first run. Long enough that boot work is finished
   * and a start/stop cycle in a test never fires at all.
   */
  bootDelayMs: number;
  /**
   * The work. May be sync or async; a rejection is caught and logged.
   *
   * Any return value is ignored, so a job whose underlying function reports a
   * result (`runAutoBackup` returns what it wrote) can be passed straight in
   * without a discarding wrapper.
   */
  tick: () => unknown;
  /**
   * When true the job logs that it is disabled and starts nothing. Passed in
   * rather than read from env here so each job keeps its own switch.
   */
  disabled?: boolean;
  /** Extra fields for the "started" log line. */
  logContext?: Record<string, unknown>;
}

export interface IntervalJob {
  start(): void;
  stop(): void;
  /**
   * Run the work right now, outside the schedule, and wait for it. This is the
   * seam the tests use: nothing else can observe a job whose real interval is
   * measured in hours. Respects the same one-at-a-time rule as a timed tick.
   */
  runNow(): Promise<void>;
  readonly running: boolean;
}

export function createIntervalJob(options: IntervalJobOptions): IntervalJob {
  const log = createLogger(options.name);

  let bootTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  // Held across an async tick so an overrun cannot overlap with the next one.
  let inFlight: Promise<void> | null = null;

  async function invoke(): Promise<void> {
    if (inFlight) {
      log.debug('previous run is still going; skipping this tick');
      return inFlight;
    }
    const run = (async () => {
      try {
        await options.tick();
      } catch (error) {
        // Detached from any request, so there is nobody to hand this to. Log it
        // and let the next tick try again.
        log.error(`${options.name} run failed`, { error: String(error) });
      }
    })();
    inFlight = run;
    try {
      await run;
    } finally {
      inFlight = null;
    }
  }

  return {
    start(): void {
      if (options.disabled) {
        log.info(`${options.name} disabled by configuration`);
        return;
      }
      if (intervalTimer || bootTimer) return;

      bootTimer = setTimeout(() => {
        bootTimer = null;
        void invoke();
      }, options.bootDelayMs);
      bootTimer.unref();

      intervalTimer = setInterval(() => void invoke(), options.intervalMs);
      intervalTimer.unref();

      log.info(`${options.name} started`, {
        everyMinutes: Math.round(options.intervalMs / 60_000),
        ...(options.logContext ?? {}),
      });
    },

    stop(): void {
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },

    runNow(): Promise<void> {
      return invoke();
    },

    get running(): boolean {
      return intervalTimer !== null || bootTimer !== null;
    },
  };
}
