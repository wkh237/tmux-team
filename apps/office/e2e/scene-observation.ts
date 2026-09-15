import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import type { Page, TestInfo } from '@playwright/test';

/** Test-only observation of actual WebGL submissions, not a product debug API. */
export async function installDrawObserver(page: Page) {
  await page.addInitScript(() => {
    let draws = 0;
    Object.defineProperty(window, '__officeDrawCount', { get: () => draws });
    for (const type of [WebGLRenderingContext, WebGL2RenderingContext]) {
      for (const method of [
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
      ]) {
        const original = Reflect.get(type.prototype, method);
        if (typeof original !== 'function') continue;
        Object.defineProperty(type.prototype, method, {
          configurable: true,
          writable: true,
          value: function (this: WebGLRenderingContext, ...args: number[]) {
            draws++;
            return Reflect.apply(original, this, args);
          },
        });
      }
    }
  });
}

export async function observeIdleScene(page: Page, testInfo: TestInfo, name: string) {
  await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const startMetrics = await session.send('Performance.getMetrics');
  const observation = await page.evaluate(async () => {
    // Flush the initial scheduled paint before measuring a deliberately idle interval.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const before = Number(Reflect.get(window, '__officeDrawCount'));
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      before,
      after: Number(Reflect.get(window, '__officeDrawCount')),
      durationMs: performance.now() - start,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
    };
  });
  const endMetrics = await session.send('Performance.getMetrics');
  await session.detach();
  const metric = (metrics: { name: string; value: number }[], name: string) =>
    metrics.find((item) => item.name === name)?.value;
  const taskBefore = metric(startMetrics.metrics, 'TaskDuration');
  const taskAfter = metric(endMetrics.metrics, 'TaskDuration');
  const evidence = {
    ...observation,
    host: { platform: platform(), architecture: arch(), cpu: cpus()[0]?.model },
    taskDurationSeconds:
      taskBefore === undefined || taskAfter === undefined ? null : taskAfter - taskBefore,
    jsHeapUsedBytes: metric(endMetrics.metrics, 'JSHeapUsedSize'),
    note: 'Headless Chromium renderer-thread observation; heap is not total browser or GPU memory.',
  };
  const path = testInfo.outputPath(`${name}-idle-rendering.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2));
  await testInfo.attach(`${name}-idle-rendering`, {
    contentType: 'application/json',
    path,
  });
  expect(observation.before).toBeGreaterThan(0);
  expect(observation.after).toBe(observation.before);
}
