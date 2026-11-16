// Browser tests for a drive: two ends, the routes between them, the cameras on each route.
// Run: npx playwright test drive
import { test, expect } from '@playwright/test';
import { PLACES, expectedOnRoute } from './mocks.js';
import { open, press, origin, isSheet, option } from './helpers.js';

const START = '200 North Spring Street, Los Angeles';
const END = '1685 Main St, Santa Monica';
const streets = expectedOnRoute('streets', PLACES.spring, PLACES.santaMonica);
const fast = expectedOnRoute('fast', PLACES.spring, PLACES.santaMonica);

const trip = (page) => page.evaluate(() => {
  const t = window.__app.state.trip;
  return {
    mode: window.__app.state.mode, phase: t.phase, pick: t.pick, from: t.from?.label, to: t.to?.label,
    routes: t.routes.map((r) => ({ kind: r.kind, hits: r.hits.length })),
  };
});
const rows = (page) => page.locator('#view > ol.cams .row__main strong').allTextContents();
const route = (page, i) => page.locator('.routes [role="radio"]').nth(i);

async function openDrive(page) {
  await press(page.locator('#open-trip'));
  await expect(page.locator('#from')).toBeVisible();
}

async function setEnd(page, id, typed, pick) {
  await page.locator(id).fill(typed);
  await press(option(page, pick));
}

/** Open the drive form and enter both ends. */
async function enterEnds(page) {
  await openDrive(page);
  await setEnd(page, '#from', '200 n', '200 North Spring');
  await setEnd(page, '#to', '1685 main', '1685 Main');
}

async function drive(page) {
  await enterEnds(page);
  await expect(page.locator('.count__n')).toBeVisible();
}

test.describe('drive form', () => {
  test('the button in the panel opens it', async ({ page }) => {
    await open(page);
    await press(page.locator('[data-trip]'));
    await expect(page.locator('#from')).toBeVisible();
    await expect(page.locator('#to')).toBeVisible();
    await expect(page.locator('#near')).toBeHidden();
    await expect(page.locator('#view h1')).toHaveText('Cameras on a drive');
    await expect(page.locator('.lede')).toContainText('Enter where the drive starts and where it ends.');
    expect((await trip(page)).mode).toBe('trip');
  });

  test('a drive opened from an address starts there', async ({ page }) => {
    await open(page);
    await page.locator('#q').fill('200 n');
    await press(option(page, '200 North Spring'));
    await expect(page.locator('.count__n')).toBeVisible();
    await openDrive(page);
    await expect(page.locator('#from')).toHaveValue(START);
    await expect(page.locator('.lede')).toContainText('Now enter where the drive ends.');
    await expect(page.locator('.pin--end')).toHaveCount(1);
    expect(await origin(page)).toBeNull();
  });

  test('closing an empty drive returns to the overview', async ({ page }) => {
    await open(page);
    await openDrive(page);
    await press(page.locator('#close-trip'));
    await expect(page.locator('#q')).toBeVisible();
    await expect(page.locator('#trip')).toBeHidden();
    await expect(page.locator('#view h1')).toHaveText('Speed cameras in Los Angeles');
    await expect(page.locator('#open-trip')).toBeFocused();
  });

  test('it fits the screen and stays above the panel', async ({ page }) => {
    await open(page);
    await drive(page);
    const box = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, w: innerWidth,
      search: document.querySelector('#search').getBoundingClientRect().toJSON(),
      panel: document.querySelector('#panel').getBoundingClientRect().toJSON(),
      to: document.querySelector('#to').getBoundingClientRect().toJSON(),
    }));
    expect(box.scroll).toBeLessThanOrEqual(box.w);
    expect(box.search.left).toBeGreaterThanOrEqual(0);
    expect(box.search.right).toBeLessThanOrEqual(box.w);
    expect(box.to.width).toBeGreaterThan(120);
    if (await isSheet(page)) expect(box.search.bottom).toBeLessThanOrEqual(box.panel.top);
  });
});

test.describe('cameras on a drive', () => {
  test('counts each route, and says when city streets pass more', async ({ page }) => {
    const { errors } = await open(page);
    await drive(page);
    expect(fast.hits).toEqual([]);
    expect(streets.hits).toHaveLength(6);

    // The fastest route is a freeway: no camera. The page must not leave it at that.
    await expect(page.locator('.count__n')).toHaveText('0');
    await expect(page.locator('.count__what')).toContainText(`${START} to ${END}`);
    await expect(page.locator('.mix')).toContainText('This route runs along no street with a camera.');
    await expect(page.locator('.mix')).toContainText('The route that avoids freeways passes 6 cameras.');
    await expect(page.locator('.routes [role="radio"]')).toHaveCount(2);
    await expect(route(page, 0)).toHaveAttribute('aria-checked', 'true');
    await expect(route(page, 0)).toContainText('Fastest route');
    await expect(route(page, 0)).toContainText('without traffic');
    await expect(route(page, 1)).toContainText('Route that avoids freeways');
    await expect(page.locator('.cam.is-near')).toHaveCount(0);
    // With a route on the map, a camera that is not on it fades: the map must agree with "0".
    await expect(page.locator('html')).toHaveClass(/has-route/);
    expect(await page.locator('.cam__btn').first().evaluate((node) => getComputedStyle(node).opacity)).toBe('0.3');

    await press(route(page, 1));
    await expect(page.locator('.count__n')).toHaveText('6');
    await expect(page.locator('#status')).toHaveText(/6 cameras on this route/);
    // The count stays in view: picking a route must not scroll it under the top of the panel.
    expect(await page.locator('#body').evaluate((node) => node.scrollTop)).toBe(0);
    expect(await rows(page)).toEqual(streets.hits);
    await expect(page.locator('#view > ol.cams .dist').first()).toHaveText('at 1.2 mi');
    await expect(page.locator('.cam.is-near')).toHaveCount(6);
    await expect(page.locator('.pin--end')).toHaveCount(2);
    expect(await trip(page)).toMatchObject({ phase: 'ready', pick: 1, from: START, to: END });
    expect(errors).toEqual([]);
  });

  test('Enter in each field picks its end', async ({ page }) => {
    await open(page);
    await openDrive(page);
    await page.locator('#from').fill('200 N Spring St');
    await page.locator('#from').press('Enter');
    await expect(page.locator('.pin--end')).toHaveCount(1);
    await page.locator('#to').fill('1685 Main St, Santa Monica');
    await page.locator('#to').press('Enter');
    await expect(page.locator('.count__n')).toBeVisible();
    expect(await trip(page)).toMatchObject({ phase: 'ready', from: START, to: END });
  });

  test('a camera opens with its place on the drive, and Back returns', async ({ page }) => {
    await open(page);
    await drive(page);
    await press(route(page, 1));
    await press(page.locator('#view > ol.cams .row').first());
    await expect(page.locator('#view h1')).toHaveText(streets.hits[0]);
    await expect(page.locator('.facts')).toContainText('On this drive');
    await expect(page.locator('.facts')).toContainText('At 1.2 mi');
    await expect(page.locator('.facts')).toContainText('The route runs along this stretch');
    await expect(page.locator('[data-back]')).toContainText('Back to the drive');
    await press(page.locator('[data-back]'));
    await expect(page.locator('.count__n')).toHaveText('6');
  });

  test('camera streets the route only crosses are listed apart', async ({ page }) => {
    await open(page);
    await drive(page);
    const fold = page.locator('.crossed');
    await expect(fold.locator('summary')).toHaveText('1 camera street the route only crosses');
    await press(fold.locator('summary'));
    await expect(fold.locator('.row__main strong')).toHaveText(fast.crossed);
    await expect(fold).toContainText('does not count');
    // A crossed street is not a camera on the drive.
    await expect(page.locator('.count__n')).toHaveText('0');
  });

  test('arrow keys move between the routes', async ({ page }) => {
    await open(page);
    await drive(page);
    await route(page, 0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(route(page, 1)).toHaveAttribute('aria-checked', 'true');
    await expect(route(page, 1)).toBeFocused();
    await expect(page.locator('.count__n')).toHaveText('6');
    await page.keyboard.press('ArrowDown');
    await expect(route(page, 0)).toHaveAttribute('aria-checked', 'true');
  });

  test('the map draws the picked route and the other one', async ({ page }) => {
    await open(page);
    await drive(page);
    await press(route(page, 1));
    const drawn = await page.evaluate(async () => {
      const count = async (id) => (await window.__app.map.getSource(id).getData()).features.length;
      return { trip: await count('trip'), alt: await count('trip-alt'), hits: await count('trip-hits') };
    });
    expect(drawn).toEqual({ trip: 1, alt: 1, hits: 6 });
  });

  test('swap reverses the drive', async ({ page }) => {
    const { calls } = await open(page);
    await drive(page);
    await press(page.locator('#swap'));
    await expect(page.locator('#from')).toHaveValue(END);
    await expect(page.locator('#to')).toHaveValue(START);
    await expect(page.locator('.count__what')).toContainText(`${END} to ${START}`);
    await press(route(page, 1));
    await expect(page.locator('.count__n')).toHaveText('6');
    expect(await rows(page)).toEqual([...streets.hits].reverse());
    const last = calls.drives.at(-1);
    expect(last.from.lat).toBeCloseTo(PLACES.santaMonica.lat, 4);
    expect(last.to.lat).toBeCloseTo(PLACES.spring.lat, 4);
  });

  test('an emptied field drops that end and the routes', async ({ page }) => {
    await open(page);
    await drive(page);
    await page.locator('#to').fill('');
    await expect(page.locator('#view h1')).toHaveText('Cameras on a drive');
    await expect(page.locator('.lede')).toContainText('Now enter where the drive ends.');
    await expect(page.locator('.pin--end')).toHaveCount(1);
    expect(await trip(page)).toMatchObject({ phase: 'idle', routes: [], from: START });
    expect((await trip(page)).to).toBeUndefined();
  });

  test('closing the drive keeps the start as the address', async ({ page }) => {
    await open(page);
    await drive(page);
    await press(page.locator('#close-trip'));
    await expect(page.locator('#q')).toHaveValue(START);
    await expect(page.locator('.count__what')).toContainText('within 2 miles');
    await expect(page.locator('.pin--end')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/has-route/);
    expect((await origin(page)).label).toBe(START);
    expect(await trip(page)).toMatchObject({ mode: 'near', phase: 'idle', routes: [] });
  });

  test('the two places go to the route service in the request body, not the address', async ({ page }) => {
    const { calls } = await open(page);
    await drive(page);
    expect(calls.filter((url) => url.includes('valhalla'))).toEqual(Array(2).fill('https://valhalla1.openstreetmap.de/route'));
    expect(calls.drives.map((d) => d.method)).toEqual(['POST', 'POST']);
    expect(calls.drives.map((d) => d.streets).sort()).toEqual([false, true]);
  });
});

test.describe('route services', () => {
  test('one route when the fastest way already avoids freeways', async ({ page }) => {
    await open(page, { router: 'same' });
    await drive(page);
    await expect(page.locator('.routes')).toHaveCount(0);
    await expect(page.locator('.trip__sum')).toContainText('without traffic');
    await expect(page.locator('.notice')).toHaveCount(0);
    expect((await trip(page)).routes).toEqual([{ kind: 'fast', hits: 0 }]);
  });

  test('says so when the route that avoids freeways does not load', async ({ page }) => {
    await open(page, { router: 'streets-down' });
    await drive(page);
    await expect(page.locator('.count__n')).toHaveText('0');
    await expect(page.locator('.routes')).toHaveCount(0);
    await expect(page.locator('.notice')).toContainText('The route that avoids freeways did not load.');
  });

  test('the second service answers when the first is down', async ({ page }) => {
    const { calls } = await open(page, { router: 'down' });
    await drive(page);
    await expect(page.locator('.count__n')).toHaveText('0');
    await expect(page.locator('.trip__sum')).toContainText('Via');
    await expect(page.locator('.notice')).toContainText('did not load');
    expect(calls.some((url) => url.includes('routing.openstreetmap.de'))).toBe(true);
  });

  test('no service answers: the page says so and offers another try', async ({ page }) => {
    const { calls, errors } = await open(page, { router: 'down', backup: 'down' });
    await enterEnds(page);
    await expect(page.locator('#view h1')).toHaveText('The route did not load');
    const before = calls.drives.length;
    await press(page.locator('[data-retry]'));
    await expect.poll(() => calls.drives.length).toBeGreaterThan(before);
    await expect(page.locator('#view h1')).toHaveText('The route did not load');
    expect(errors).toEqual([]);
  });

  test('no road between the two places', async ({ page }) => {
    await open(page, { router: 'none' });
    await enterEnds(page);
    await expect(page.locator('#view h1')).toHaveText('No driving route');
    await expect(page.locator('.lede')).toContainText(`from ${START} to ${END}`);
  });

  test('a closed drive drops a late answer', async ({ page }) => {
    await open(page, { routeDelay: 700 });
    await enterEnds(page);
    await expect(page.locator('#view h1')).toHaveText('Finding the route');
    await press(page.locator('#close-trip'));
    await page.waitForTimeout(1100);
    await expect(page.locator('#q')).toHaveValue(START);
    await expect(page.locator('.count__what')).toContainText('within 2 miles');
    await expect(page.locator('.pin--end')).toHaveCount(0);
    expect(await trip(page)).toMatchObject({ mode: 'near', routes: [] });
  });
});
