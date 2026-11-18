// Browser tests for the Vercel Web Analytics events.
// Vercel's script is not on the test server, so every call stays in window.vaq. Run: npx playwright test events
import { test, expect } from '@playwright/test';
import { mockNetwork, expectedNear, expectedOnRoute, PLACES } from './mocks.js';
import { open, press, option } from './helpers.js';

const NEAR = `?at=${PLACES.melrose.lat.toFixed(5)},${PLACES.melrose.lon.toFixed(5)}&place=${encodeURIComponent('6300 Melrose Ave, Los Angeles')}`;
const DRIVE = `?drive=1&from=${PLACES.spring.lat.toFixed(5)},${PLACES.spring.lon.toFixed(5)}&fromName=City+Hall`
  + `&to=${PLACES.santaMonica.lat.toFixed(5)},${PLACES.santaMonica.lon.toFixed(5)}&toName=Santa+Monica`;
const near = expectedNear(PLACES.melrose, 2);
const fast = expectedOnRoute('fast', PLACES.spring, PLACES.santaMonica).hits.length;

const events = (page) => page.evaluate(() => [...(window.vaq || [])]
  .filter(([kind]) => kind === 'event').map(([, event]) => event));

async function enterEnds(page) {
  await press(page.locator('#open-trip'));
  await page.locator('#from').fill('200 n');
  await press(option(page, '200 North Spring'));
  await page.locator('#to').fill('1685 main');
  await press(option(page, '1685 Main'));
}

test.describe('address search event', () => {
  test('a picked address sends the count, not the address', async ({ page }) => {
    await open(page);
    await page.locator('#q').fill('6300 mel');
    await press(option(page, '6300 Melrose Ave'));
    await expect(page.locator('.count__n')).toHaveText(String(near));
    expect(await events(page)).toEqual([{ name: 'Address search', data: { kind: 'address', cameras: near } }]);
  });

  test('a pick that a newer action replaced sends no event', async ({ page }) => {
    await mockNetwork(page);
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/data/city.geojson', async (route) => { await gate; await route.continue(); });
    await page.goto('/');
    await expect(page.locator('.legend li')).toHaveCount(2);
    await page.locator('#q').fill('6300 mel');
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('findAddressCandidates')),
      press(option(page, '6300 Melrose Ave')),
    ]);
    await press(page.locator('#clear'));
    release();
    await page.waitForFunction(() => window.__app?.map.loaded());
    expect(await events(page)).toEqual([]);
  });

  test('a shared address link sends no event', async ({ page }) => {
    await mockNetwork(page);
    await page.goto(`/${NEAR}`);
    await expect(page.locator('.count__n')).toHaveText(String(near));
    expect(await events(page)).toEqual([]);
  });

  test.describe('with location', () => {
    test.use({ permissions: ['geolocation'] });

    test('the location button sends the kind "gps"', async ({ page, context }) => {
      await context.setGeolocation({ latitude: PLACES.melrose.lat, longitude: PLACES.melrose.lon });
      await open(page);
      await press(page.locator('#locate'));
      await expect(page.locator('.count__n')).toHaveText(String(near));
      expect(await events(page)).toEqual([{ name: 'Address search', data: { kind: 'gps', cameras: near } }]);
    });
  });
});

test.describe('drive lookup event', () => {
  test('a drive sends the result and the count on the route', async ({ page }) => {
    await open(page);
    await enterEnds(page);
    await expect(page.locator('.count__n')).toHaveText(String(fast));
    expect(await events(page)).toEqual([{ name: 'Drive lookup', data: { result: 'ready', cameras: fast } }]);
  });

  test('a route that does not load sends the result "failed"', async ({ page }) => {
    await open(page, { router: 'down', backup: 'down' });
    await enterEnds(page);
    await expect(page.locator('#view h1')).toHaveText('The route did not load');
    expect(await events(page)).toEqual([{ name: 'Drive lookup', data: { result: 'failed' } }]);
  });

  test('a shared drive link sends no event', async ({ page }) => {
    await mockNetwork(page);
    await page.goto(`/${DRIVE}`);
    await expect(page.locator('.count__n')).toHaveText(String(fast));
    expect(await events(page)).toEqual([]);
  });
});

test.describe('what Vercel gets', () => {
  test('both scripts get the page address without the searched address', async ({ page }) => {
    await mockNetwork(page);
    await page.goto(`/${NEAR}`);
    await expect(page.locator('.count__n')).toHaveText(String(near));
    const sent = await page.evaluate(() => [window.vaq, window.siq].map((queue) => {
      const [kind, hook] = [...(queue || [])][0] || [];
      return kind === 'beforeSend' ? hook({ type: 'pageview', url: location.href }).url : `first call: ${kind}`;
    }));
    expect(page.url()).toContain('place=');
    expect(sent).toEqual([`${new URL(page.url()).origin}/`, `${new URL(page.url()).origin}/`]);
  });

  test('a request to this site names the site only, not the searched address', async ({ page }) => {
    await mockNetwork(page);
    await page.goto(`/${NEAR}`);
    await expect(page.locator('.count__n')).toHaveText(String(near));
    const [request] = await Promise.all([
      page.waitForRequest('**/robots.txt'),
      page.evaluate(() => { fetch('/robots.txt').catch(() => {}); }),
    ]);
    expect(page.url()).toContain('place=');
    expect((await request.allHeaders()).referer).toBe(`${new URL(page.url()).origin}/`);
  });
});
