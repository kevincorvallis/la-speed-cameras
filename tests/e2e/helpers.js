// Shared steps for the browser tests.
import { test, expect } from '@playwright/test';
import { mockNetwork, cameras } from './mocks.js';

/** Open the page with every outside host faked, and wait until it has settled. */
export async function open(page, options) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const calls = await mockNetwork(page, options);
  await page.goto('/');
  await expect(page.locator('.cam')).toHaveCount(cameras.length);
  await expect(page.locator('#foot .source')).toContainText(/last changed|saved/);
  if (options?.tiles !== 'down') await page.waitForFunction(() => window.__app?.map.loaded());
  return { errors, calls };
}

/** Press the way this screen is pressed: a finger tap on touch screens, a mouse click elsewhere. */
export const press = (locator) => (test.info().project.use.hasTouch ? locator.tap() : locator.click());
export const origin = (page) => page.evaluate(() => window.__app.state.origin);
export const isSheet = (page) => page.evaluate(() => matchMedia('(max-width: 719px) and (min-height: 480px)').matches);
export const option = (page, text) => page.locator('#suggest [role="option"]').filter({ hasText: text }).first();
