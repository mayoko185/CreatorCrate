const MINUTE_IN_MILLISECONDS = 60 * 1000;
const MAX_NODE_TIMER_DELAY_MILLISECONDS = 2_147_483_647;

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function';
}

/**
 * Create the process-local recurring project scan scheduler.
 *
 * Dependencies are resolved through `getScanDependencies` for every cycle
 * and every project. This is deliberate: the application context can rebuild
 * its database-bound app after a live restore.
 *
 * @param {object} deps
 * @param {number|null} deps.intervalMinutes - null disables scheduling
 * @param {() => {projectService: object, assetScanner: object}} deps.getScanDependencies
 * @param {typeof setInterval} [deps.setIntervalFn]
 * @param {typeof clearInterval} [deps.clearIntervalFn]
 * @param {Console} [deps.logger]
 * @returns {{ start(): boolean, stop(): boolean, runCycle(): Promise<object> }}
 */
export function createAutomaticProjectScanScheduler({
  intervalMinutes,
  getScanDependencies,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  if (intervalMinutes !== null && (!Number.isSafeInteger(intervalMinutes) || intervalMinutes <= 0)) {
    throw new Error('Automatic project scan interval must be null or a positive safe integer.');
  }
  const intervalMilliseconds = intervalMinutes === null
    ? null
    : intervalMinutes * MINUTE_IN_MILLISECONDS;
  if (
    intervalMilliseconds !== null &&
    intervalMilliseconds > MAX_NODE_TIMER_DELAY_MILLISECONDS
  ) {
    throw new Error(
      `Automatic project scan interval must not exceed Node's maximum timer delay of ${MAX_NODE_TIMER_DELAY_MILLISECONDS} milliseconds.`
    );
  }
  if (typeof getScanDependencies !== 'function') {
    throw new Error('Automatic project scan scheduler requires a dependency getter.');
  }

  let timerHandle = null;
  let cycleRunning = false;
  let stopped = false;

  async function runCycle() {
    if (intervalMinutes === null) {
      return { skipped: true, reason: 'disabled' };
    }

    if (stopped) {
      return { skipped: true, reason: 'stopped' };
    }

    if (cycleRunning) {
      logger.log('[CreatorCrate] Automatic project scan skipped; a previous cycle is still running.');
      return { skipped: true, reason: 'overlap' };
    }

    cycleRunning = true;
    const summary = { scanned: 0, failed: 0 };

    try {
      logger.log('[CreatorCrate] Automatic project scan cycle started.');

      const { projectService } = getScanDependencies();
      const projectResult = projectService.listScanEligibleProjects();
      const projects = isPromiseLike(projectResult) ? await projectResult : projectResult;

      for (const project of projects) {
        if (stopped) break;

        try {
          // Resolve the scanner again for each project so a context rebuild
          // between projects cannot leave this cycle using a closed database.
          const { assetScanner } = getScanDependencies();
          const scanResult = assetScanner.scanProjectAssets(project.id);
          if (isPromiseLike(scanResult)) await scanResult;
          summary.scanned += 1;
        } catch (error) {
          summary.failed += 1;
          logger.error(
            `[CreatorCrate] Automatic scan failed for project ${project.id}: ${formatError(error)}`
          );
        }
      }

      logger.log(
        `[CreatorCrate] Automatic project scan cycle completed: ` +
        `${summary.scanned} scanned, ${summary.failed} failed.`
      );
      return summary;
    } catch (error) {
      // Enumeration or another cycle-level failure must not make the timer's
      // callback reject or leave the overlap guard permanently set.
      logger.error(`[CreatorCrate] Automatic project scan cycle failed: ${formatError(error)}`);
      return summary;
    } finally {
      cycleRunning = false;
    }
  }

  function triggerCycle() {
    void runCycle().catch((error) => {
      // `runCycle` handles expected failures; this is a final safety net for
      // unexpected logger/dependency failures from a timer callback.
      logger.error(`[CreatorCrate] Automatic project scan cycle failed: ${formatError(error)}`);
    });
  }

  function start() {
    if (intervalMinutes === null || timerHandle !== null) {
      return false;
    }

    stopped = false;
    timerHandle = setIntervalFn(triggerCycle, intervalMilliseconds);
    logger.log(
      `[CreatorCrate] Automatic project scanning enabled: every ${intervalMinutes} minute` +
      `${intervalMinutes === 1 ? '' : 's'}.`
    );
    return true;
  }

  function stop() {
    stopped = true;
    if (timerHandle === null) {
      return false;
    }

    clearIntervalFn(timerHandle);
    timerHandle = null;
    return true;
  }

  return { start, stop, runCycle };
}
