import { describe, it, expect, vi } from 'vitest';
import { createApplicationContext } from '../src/app-context.js';
import {
  AUTO_SCAN_LAST_COMPLETED_AT_KEY,
  AUTO_SCAN_NEXT_SCHEDULED_AT_KEY,
  createAutomaticProjectScanScheduler,
} from '../src/services/automatic-project-scan-scheduler.js';

function makeLogger() {
  return { log: vi.fn(), error: vi.fn() };
}

function makeAppMetaRepository(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));
  return {
    values,
    getValue: vi.fn((key) => values.get(key)),
    setValue: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    }),
  };
}

function makeTimerHarness() {
  let callback;
  const handle = { timer: true };
  const setIntervalFn = vi.fn((fn, delay) => {
    callback = fn;
    return handle;
  });
  const clearIntervalFn = vi.fn();
  return { get callback() { return callback; }, handle, setIntervalFn, clearIntervalFn };
}

function makeDependencies(scanner, projectService = {
  listScanEligibleProjects: () => [],
}, appMetaRepository = makeAppMetaRepository()) {
  return { projectService, assetScanner: scanner, appMetaRepository };
}

describe('automatic project scan scheduler', () => {
  it('does not create a timer or scan when automatic scanning is disabled', async () => {
    const timer = makeTimerHarness();
    const getScanDependencies = vi.fn(() => makeDependencies({
      listScanEligibleProjects: vi.fn(),
      scanProjectAssets: vi.fn(),
    }));
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: null,
      getScanDependencies,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      logger: makeLogger(),
    });

    expect(scheduler.start()).toBe(false);
    await expect(scheduler.runCycle()).resolves.toEqual({ skipped: true, reason: 'disabled' });
    expect(timer.setIntervalFn).not.toHaveBeenCalled();
    expect(getScanDependencies).not.toHaveBeenCalled();
  });

  it('schedules enabled scanning at the configured minute interval without an immediate scan', () => {
    const timer = makeTimerHarness();
    const appMetaRepository = makeAppMetaRepository();
    const scanner = {
      listScanEligibleProjects: vi.fn(),
      scanProjectAssets: vi.fn(),
    };
    const getScanDependencies = vi.fn(() => makeDependencies(scanner, undefined, appMetaRepository));
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 15,
      getScanDependencies,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      logger: makeLogger(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(scheduler.start()).toBe(true);
    expect(timer.setIntervalFn).toHaveBeenCalledOnce();
    expect(timer.setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 15 * 60 * 1000);
    expect(getScanDependencies).toHaveBeenCalledOnce();
    expect(appMetaRepository.setValue).toHaveBeenCalledWith(
      AUTO_SCAN_NEXT_SCHEDULED_AT_KEY,
      '2026-01-01T00:15:00.000Z',
    );
    expect(scanner.scanProjectAssets).not.toHaveBeenCalled();
  });

  it('rejects an interval whose timer delay exceeds Node timer limits', () => {
    expect(() => createAutomaticProjectScanScheduler({
      intervalMinutes: 35792,
      getScanDependencies: () => makeDependencies({}),
      logger: makeLogger(),
    })).toThrow(
      "Automatic project scan interval must not exceed Node's maximum timer delay of 2147483647 milliseconds."
    );
  });

  it('scans every eligible project sequentially', async () => {
    const events = [];
    let releaseFirst;
    let firstStarted;
    const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
    const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
    const scanner = {
      listScanEligibleProjects: vi.fn(),
      scanProjectAssets: vi.fn(async (projectId) => {
        events.push(`start:${projectId}`);
        if (projectId === 1) {
          firstStarted();
          await firstRelease;
        }
        events.push(`end:${projectId}`);
      }),
    };
    const projectService = {
      listScanEligibleProjects: vi.fn(() => [{ id: 1 }, { id: 2 }, { id: 3 }]),
    };
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 1,
      getScanDependencies: () => makeDependencies(scanner, projectService),
      logger: makeLogger(),
    });

    const cycle = scheduler.runCycle();
    await firstStartedPromise;
    expect(events).toEqual(['start:1']);

    releaseFirst();
    await cycle;
    expect(events).toEqual([
      'start:1', 'end:1',
      'start:2', 'end:2',
      'start:3', 'end:3',
    ]);
  });

  it('records completion and the next scheduled time after an automatic cycle', async () => {
    const appMetaRepository = makeAppMetaRepository();
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 15,
      getScanDependencies: () => makeDependencies(
        { scanProjectAssets: vi.fn() },
        { listScanEligibleProjects: vi.fn(() => [{ id: 1 }]) },
        appMetaRepository,
      ),
      logger: makeLogger(),
      now: () => new Date('2026-01-01T01:00:00.000Z'),
    });

    await expect(scheduler.runCycle()).resolves.toEqual({ scanned: 1, failed: 0 });
    expect(appMetaRepository.setValue).toHaveBeenNthCalledWith(
      1,
      AUTO_SCAN_LAST_COMPLETED_AT_KEY,
      '2026-01-01T01:00:00.000Z',
    );
    expect(appMetaRepository.setValue).toHaveBeenNthCalledWith(
      2,
      AUTO_SCAN_NEXT_SCHEDULED_AT_KEY,
      '2026-01-01T01:15:00.000Z',
    );
  });

  it('isolates one project failure and continues with later projects', async () => {
    const appMetaRepository = makeAppMetaRepository();
    const scanner = {
      listScanEligibleProjects: vi.fn(),
      scanProjectAssets: vi.fn(async (projectId) => {
        if (projectId === 2) throw new Error('directory unavailable');
      }),
    };
    const projectService = {
      listScanEligibleProjects: vi.fn(() => [{ id: 1 }, { id: 2 }, { id: 3 }]),
    };
    const logger = makeLogger();
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 1,
      getScanDependencies: () => makeDependencies(scanner, projectService, appMetaRepository),
      logger,
      now: () => new Date('2026-01-01T01:00:00.000Z'),
    });

    await expect(scheduler.runCycle()).resolves.toEqual({ scanned: 2, failed: 1 });
    expect(scanner.scanProjectAssets).toHaveBeenCalledTimes(3);
    expect(scanner.scanProjectAssets.mock.calls.map(([projectId]) => projectId)).toEqual([1, 2, 3]);
    expect(logger.error).toHaveBeenCalledWith(
      '[CreatorCrate] Automatic scan failed for project 2: directory unavailable'
    );
    expect(appMetaRepository.setValue).toHaveBeenNthCalledWith(
      1,
      AUTO_SCAN_LAST_COMPLETED_AT_KEY,
      '2026-01-01T01:00:00.000Z',
    );
    expect(appMetaRepository.setValue).toHaveBeenNthCalledWith(
      2,
      AUTO_SCAN_NEXT_SCHEDULED_AT_KEY,
      '2026-01-01T01:01:00.000Z',
    );
  });

  it('skips overlapping cycle invocation', async () => {
    const appMetaRepository = makeAppMetaRepository();
    let releaseScan;
    let scanStarted;
    const scanStartedPromise = new Promise((resolve) => { scanStarted = resolve; });
    const scanRelease = new Promise((resolve) => { releaseScan = resolve; });
    const scanner = {
      scanProjectAssets: vi.fn(async () => {
        scanStarted();
        await scanRelease;
      }),
    };
    const projectService = {
      listScanEligibleProjects: vi.fn(() => [{ id: 1 }]),
    };
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 1,
      getScanDependencies: () => makeDependencies(scanner, projectService, appMetaRepository),
      logger: makeLogger(),
      now: () => new Date('2026-01-01T01:00:00.000Z'),
    });

    const firstCycle = scheduler.runCycle();
    await scanStartedPromise;
    await expect(scheduler.runCycle()).resolves.toEqual({ skipped: true, reason: 'overlap' });
    expect(scanner.scanProjectAssets).toHaveBeenCalledOnce();
    expect(appMetaRepository.setValue).not.toHaveBeenCalled();

    releaseScan();
    await firstCycle;
    expect(appMetaRepository.setValue).toHaveBeenCalledTimes(2);
  });

  it('resets overlap state after successful and failed cycles', async () => {
    let shouldFail = false;
    const scanner = {
      scanProjectAssets: vi.fn(async () => {
        if (shouldFail) throw new Error('transient scan failure');
      }),
    };
    const projectService = {
      listScanEligibleProjects: vi.fn(() => [{ id: 1 }]),
    };
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 1,
      getScanDependencies: () => makeDependencies(scanner, projectService),
      logger: makeLogger(),
    });

    await scheduler.runCycle();
    shouldFail = true;
    await scheduler.runCycle();
    shouldFail = false;
    await scheduler.runCycle();

    expect(scanner.scanProjectAssets).toHaveBeenCalledTimes(3);
  });

  it('can run again after project enumeration fails', async () => {
    let shouldFail = true;
    const scanner = { scanProjectAssets: vi.fn() };
    const projectService = {
      listScanEligibleProjects: vi.fn(() => {
        if (shouldFail) throw new Error('database temporarily unavailable');
        return [{ id: 1 }];
      }),
    };
    const logger = makeLogger();
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 1,
      getScanDependencies: () => makeDependencies(scanner, projectService),
      logger,
    });

    await expect(scheduler.runCycle()).resolves.toEqual({ scanned: 0, failed: 0 });
    shouldFail = false;
    await expect(scheduler.runCycle()).resolves.toEqual({ scanned: 1, failed: 0 });
    expect(scanner.scanProjectAssets).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[CreatorCrate] Automatic project scan cycle failed: database temporarily unavailable'
    );
  });

  it('resolves the current application dependencies after a context replacement', async () => {
    const firstScanner = {
      scanProjectAssets: vi.fn(),
    };
    const secondScanner = {
      scanProjectAssets: vi.fn(),
    };
    const firstProjectService = {
      listScanEligibleProjects: vi.fn(() => [{ id: 1 }]),
    };
    const secondProjectService = {
      listScanEligibleProjects: vi.fn(() => [{ id: 2 }]),
    };
    let buildIndex = 0;
    const apps = [
      {
        locals: {
          projectService: firstProjectService,
          assetScanner: firstScanner,
          appMetaRepository: makeAppMetaRepository(),
        },
      },
      {
        locals: {
          projectService: secondProjectService,
          assetScanner: secondScanner,
          appMetaRepository: makeAppMetaRepository(),
        },
      },
    ];
    const appContext = createApplicationContext(
      { appName: 'CreatorCrate', appOpts: {} },
      { close: vi.fn() },
      () => apps[buildIndex++]
    );
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 1,
      getScanDependencies: () => ({
        projectService: appContext.app.locals.projectService,
        assetScanner: appContext.app.locals.assetScanner,
        appMetaRepository: appContext.app.locals.appMetaRepository,
      }),
      logger: makeLogger(),
    });

    await scheduler.runCycle();
    appContext.replaceDatabase({ close: vi.fn() });
    await scheduler.runCycle();

    expect(firstScanner.scanProjectAssets).toHaveBeenCalledWith(1);
    expect(secondScanner.scanProjectAssets).toHaveBeenCalledWith(2);
    expect(firstScanner.scanProjectAssets).toHaveBeenCalledTimes(1);
    expect(secondScanner.scanProjectAssets).toHaveBeenCalledTimes(1);
    expect(apps[0].locals.appMetaRepository.setValue).toHaveBeenCalledTimes(2);
    expect(apps[1].locals.appMetaRepository.setValue).toHaveBeenCalledTimes(2);
  });

  it('clears the recurring timer when stopped', () => {
    const timer = makeTimerHarness();
    const appMetaRepository = makeAppMetaRepository();
    const scheduler = createAutomaticProjectScanScheduler({
      intervalMinutes: 1,
      getScanDependencies: () => makeDependencies({}, undefined, appMetaRepository),
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      logger: makeLogger(),
      now: () => new Date('2026-01-01T01:00:00.000Z'),
    });

    scheduler.start();
    const persistedAtStart = [...appMetaRepository.setValue.mock.calls];
    expect(scheduler.stop()).toBe(true);
    expect(timer.clearIntervalFn).toHaveBeenCalledOnce();
    expect(timer.clearIntervalFn).toHaveBeenCalledWith(timer.handle);
    expect(scheduler.stop()).toBe(false);
    expect(timer.clearIntervalFn).toHaveBeenCalledOnce();
    expect(appMetaRepository.setValue.mock.calls).toEqual(persistedAtStart);
  });
});
