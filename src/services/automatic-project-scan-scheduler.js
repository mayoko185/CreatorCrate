const MINUTE_IN_MILLISECONDS = 60 * 1000;
const MAX_NODE_TIMER_DELAY_MILLISECONDS = 2_147_483_647;

export const AUTO_SCAN_LAST_COMPLETED_AT_KEY = 'auto_scan.last_completed_at';
export const AUTO_SCAN_NEXT_SCHEDULED_AT_KEY = 'auto_scan.next_scheduled_at';

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
 * @param {() => {projectService: object, assetScanner: object, appMetaRepository: object, watermarkService?: object}} deps.getScanDependencies
 * @param {typeof setInterval} [deps.setIntervalFn]
 * @param {typeof clearInterval} [deps.clearIntervalFn]
 * @param {Console} [deps.logger]
 * @param {object|null} [deps.applicationLogger]
 * @param {() => Date|number|string} [deps.now]
 * @returns {{ start(): boolean, stop(): boolean, runCycle(): Promise<object> }}
 */
export function createAutomaticProjectScanScheduler({
  intervalMinutes,
  getScanDependencies,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
  applicationLogger = null,
  now = () => new Date(),
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
  if (typeof now !== 'function') {
    throw new Error('Automatic project scan scheduler requires a clock function.');
  }

  let timerHandle = null;
  let cycleRunning = false;
  let stopped = false;

  function logPartialProjectScan(projectId, error) {
    try {
      applicationLogger?.warn?.({
        event: 'project.scan.partial',
        kind: 'diagnostic',
        subsystem: 'projects',
        message: 'Scheduled project asset scan completed with an error.',
        projectId,
        error,
      });
    } catch {
      // Scheduler diagnostics must never alter cycle recovery behavior.
    }
  }

  function resolveAppMetaRepository() {
    const repository = getScanDependencies()?.appMetaRepository;
    if (!repository || typeof repository.setValue !== 'function') {
      throw new Error('Automatic project scan scheduler requires an app-meta repository.');
    }
    return repository;
  }

  function resolveNow() {
    const value = now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new Error('Automatic project scan scheduler clock returned an invalid date.');
    }
    return date;
  }

  function persistNextScheduledAt(referenceDate) {
    const nextScheduledAt = new Date(
      referenceDate.getTime() + intervalMilliseconds
    ).toISOString();
    resolveAppMetaRepository().setValue(AUTO_SCAN_NEXT_SCHEDULED_AT_KEY, nextScheduledAt);
  }

  function persistCycleTimestamps() {
    const completedAt = resolveNow();
    const repository = resolveAppMetaRepository();
    repository.setValue(AUTO_SCAN_LAST_COMPLETED_AT_KEY, completedAt.toISOString());
    repository.setValue(
      AUTO_SCAN_NEXT_SCHEDULED_AT_KEY,
      new Date(completedAt.getTime() + intervalMilliseconds).toISOString(),
    );
  }

  function persistTimingSafely(operation) {
    try {
      operation();
    } catch (error) {
      logger.error(`[CreatorCrate] Automatic scan timing persistence failed: ${formatError(error)}`);
    }
  }

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

      const dependencies = getScanDependencies();
      const { projectService, watermarkService } = dependencies;
      if (watermarkService && typeof watermarkService.scanWatermarks === 'function') {
        try {
          const watermarkResult = watermarkService.scanWatermarks();
          const scan = isPromiseLike(watermarkResult) ? await watermarkResult : watermarkResult;
          if (scan?.failed > 0) {
            logger.error(`[CreatorCrate] Automatic global Watermark scan completed with ${scan.failed} failed source read(s).`);
          }
        } catch (error) {
          logger.error(`[CreatorCrate] Automatic global Watermark scan failed: ${formatError(error)}`);
        }
      }

      const projectResult = projectService.listScanEligibleProjects();
      const projects = isPromiseLike(projectResult) ? await projectResult : projectResult;

      for (const project of projects) {
        if (stopped) break;

        try {
          // Resolve the scanner again for each project so a context rebuild
          // between projects cannot leave this cycle using a closed database.
          const { assetScanner } = getScanDependencies();
          const scanResult = assetScanner.scanProjectAssets(project.id, { kind: 'diagnostic' });
          if (isPromiseLike(scanResult)) await scanResult;
          summary.scanned += 1;
        } catch (error) {
          summary.failed += 1;
          logPartialProjectScan(project.id, error);
          logger.error(
            `[CreatorCrate] Automatic scan failed for project ${project.id}: ${formatError(error)}`
          );
        }
      }

      logger.log(
        `[CreatorCrate] Automatic project scan cycle completed: ` +
        `${summary.scanned} scanned, ${summary.failed} failed.`
      );
      persistTimingSafely(persistCycleTimestamps);
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
    persistTimingSafely(() => persistNextScheduledAt(resolveNow()));
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
