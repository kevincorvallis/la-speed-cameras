// The overnight polish: first screen, share links, head tags, site files, accessibility scan.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockNetwork, expectedNear, PLACES, cameras } from './mocks.js';
import { open, press, option } from './helpers.js';

const NEAR = `?at=${PLACES.melrose.lat.toFixed(5)},${PLACES.melrose.lon.toFixed(5)}&place=${encodeURIComponent('6300 Melrose Ave, Los Angeles')}`;
const DRIVE = `?drive=1&from=${PLACES.spring.lat.toFixed(5)},${PLACES.spring.lon.toFixed(5)}&fromName=City+Hall`
  + `&to=${PLACES.santaMonica.lat.toFixed(5)},${PLACES.santaMonica.lon.toFixed(5)}&toName=Santa+Monica`;
const desktopOnly = () => test.skip(!!test.info().project.use.hasTouch, 'a mouse and keyboard screen');
const chromiumOnly = (browserName) => test.skip(browserName !== 'chromium', 'clipboard permission is Chromium only');

test.describe('first screen', () => {
  test('the heading shows before the data, then the counts replace the placeholder', async ({ page }) => {
    await mockNetwork(page);
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/data/cameras.json', async (route) => { await gate; await route.continue(); });
    await page.goto('/');
    await expect(page.locator('#view h1')).toHaveText('Speed cameras in Los Angeles');
    await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.skeleton')).toBeVisible();
    release();
    await expect(page.locator('.legend li')).toHaveCount(2);
    await expect(page.locator('#view')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('.skeleton')).toHaveCount(0);
  });

  test('the counts paint before the map code loads', async ({ page }) => {
    await mockNetwork(page);
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/vendor/maplibre-gl.mjs', async (route) => { await gate; await route.continue(); });
    await page.goto('/');
    await expect(page.locator('.legend li')).toHaveCount(2);
    await expect(page.locator('#view')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#foot .source')).toContainText(/last changed|saved/);
    await expect(page.locator('.cam')).toHaveCount(0);
    release();
    await expect(page.locator('.cam')).toHaveCount(cameras.length);
  });

  test('the saved data fails: a plain message and a way to try again', async ({ page }) => {
    await mockNetwork(page);
    await page.route('**/data/corridors.geojson', (route) => route.fulfill({ status: 503, body: 'down' }));
    await page.goto('/');
    await expect(page.locator('#view h1')).toHaveText('The camera data did not load');
    await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
    await expect(page.locator('#view')).not.toHaveAttribute('aria-busy', /.*/);
  });

  test('the font comes from this site, and no font host is called', async ({ page }) => {
    const { calls } = await open(page);
    expect(calls.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
    expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('700 16px Overpass'); })).toBe(true);
  });

  test('the overview offers both ways in', async ({ page }) => {
    await open(page);
    await expect(page.locator('#view [data-trip]')).toHaveText('Map a drive');
    await expect(page.getByRole('button', { name: 'Near me' })).toBeVisible();
  });
});

test.describe('near me button', () => {
  test.use({ permissions: ['geolocation'] });

  test('counts the cameras near the person', async ({ page, context }) => {
    await context.setGeolocation({ latitude: PLACES.melrose.lat, longitude: PLACES.melrose.lon });
    await open(page);
    await press(page.getByRole('button', { name: 'Near me' }));
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
    await expect(page.locator('#view h1')).toContainText('of your location');
    // A position is never put in a link, so there is nothing to share.
    await expect(page.locator('[data-share]')).toHaveCount(0);
  });
});

test.describe('share links', () => {
  test('a shared address link opens the same results', async ({ page }) => {
    await mockNetwork(page);
    await page.goto(`/${NEAR}`);
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
    await expect(page.locator('#q')).toHaveValue('6300 Melrose Ave, Los Angeles');
    await expect(page.getByRole('button', { name: 'Share these results' })).toBeVisible();
  });

  test('share copies the link on a desktop', async ({ page, context, browserName }) => {
    desktopOnly();
    chromiumOnly(browserName);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await page.locator('#q').fill('6300 mel');
    await press(option(page, '6300 Melrose Ave'));
    const share = page.locator('#view [data-share]');
    await expect(share).toHaveText('Share these results');
    await share.click();
    await expect(share).toHaveText('Link copied');
    await expect(page.locator('#status')).toHaveText('Link copied.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(page.url());
    expect(new URL(copied).searchParams.get('place')).toBe('6300 Melrose Ave, Los Angeles');
    await expect(share).toHaveText('Share these results', { timeout: 5000 });
  });

  test('a shared drive link opens the same drive, with its own share button', async ({ page }) => {
    await mockNetwork(page);
    await page.goto(`/${DRIVE}`);
    await expect(page.locator('#view h1.count')).toContainText('on this route');
    await expect(page.getByRole('button', { name: 'Share this drive' })).toBeVisible();
  });

  test('a camera page links to Google Maps and Street View at the camera', async ({ page }) => {
    await open(page);
    await page.locator('.all summary').click();
    await page.locator('.all .row').first().click();
    const cam = await page.evaluate(() => window.__app.state.cameras.find((c) => c.oid === window.__app.state.selected));
    await expect(page.getByRole('link', { name: 'Open in Google Maps' })).toHaveAttribute('href', `https://www.google.com/maps/search/?api=1&query=${cam.lat},${cam.lon}`);
    await expect(page.getByRole('link', { name: 'Street View' })).toHaveAttribute('href', `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${cam.lat},${cam.lon}`);
    await expect(page.getByRole('link', { name: 'Street View' })).toHaveAttribute('target', '_blank');
    await expect(page.locator('#view [data-share]')).toBeVisible();
  });

  test('the camera actions fit the panel without spilling', async ({ page }) => {
    await open(page);
    await page.locator('.all summary').click();
    await page.locator('.all .row').first().click();
    const spill = await page.evaluate(() => {
      const panel = document.querySelector('#panel').getBoundingClientRect();
      return [...document.querySelectorAll('#view .actions .btn')].some((b) => b.getBoundingClientRect().right > panel.right + 0.5);
    });
    expect(spill).toBe(false);
  });
});

test.describe('keyboard shortcut', () => {
  test('"/" jumps to the address field, but not while typing', async ({ page }) => {
    desktopOnly();
    await open(page);
    await page.locator('body').click({ position: { x: 900, y: 400 } });
    await page.keyboard.press('/');
    await expect(page.locator('#q')).toBeFocused();
    await page.keyboard.type('6300 mel/');
    await expect(page.locator('#q')).toHaveValue('6300 mel/');
  });
});

test.describe('head and site files', () => {
  test('the page names itself for search and for link previews', async ({ page }) => {
    await open(page);
    await expect(page).toHaveTitle(/LA Speed Cams/);
    const head = await page.evaluate(() => {
      const m = (sel) => document.querySelector(sel)?.getAttribute('content') ?? document.querySelector(sel)?.getAttribute('href');
      return {
        canonical: m('link[rel="canonical"]'),
        description: m('meta[name="description"]'),
        ogImage: m('meta[property="og:image"]'),
        ogUrl: m('meta[property="og:url"]'),
        twitter: m('meta[name="twitter:card"]'),
        manifest: m('link[rel="manifest"]'),
        ld: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),
      };
    });
    expect(head.canonical).toBe('https://laspeedcams.com/');
    expect(head.ogUrl).toBe('https://laspeedcams.com/');
    expect(head.ogImage).toBe('https://laspeedcams.com/og.jpg');
    expect(head.twitter).toBe('summary_large_image');
    expect(head.description.length).toBeGreaterThan(70);
    expect(head.description.length).toBeLessThan(170);
    expect(head.manifest).toBe('/site.webmanifest');
    expect(head.ld['@type']).toBe('WebApplication');
  });

  test('icons, preview image, manifest, robots and sitemap are served', async ({ request }) => {
    for (const [path, type] of [
      ['/favicon.ico', /icon/], ['/icon.svg', /svg/], ['/apple-touch-icon.png', /png/], ['/icon-192.png', /png/],
      ['/icon-512.png', /png/], ['/og.jpg', /jpeg/], ['/robots.txt', /text/], ['/sitemap.xml', /xml/],
      ['/fonts/overpass-latin-v19.woff2', /font|octet|woff/],
    ]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['content-type'], path).toMatch(type);
    }
    const manifest = await (await request.get('/site.webmanifest')).json();
    expect(manifest.name).toBe('LA Speed Cams');
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap: https://laspeedcams.com/sitemap.xml');
  });

  test('every preload is used, so none is wasted', async ({ page }) => {
    const warnings = [];
    page.on('console', (m) => { if (/preload|was preloaded/i.test(m.text())) warnings.push(m.text()); });
    await open(page);
    await page.waitForTimeout(3500); // Chromium warns 3 s after load about an unused preload
    expect(warnings).toEqual([]);
  });
});

test.describe('accessibility scan', () => {
  // axe-core checks contrast, names, roles and landmarks. The map canvas and its markers are left out:
  // MapLibre owns that markup, and the marker buttons have their own test in app.spec.js.
  const scan = (page) => new AxeBuilder({ page })
    .include('#dock')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = (r) => r.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);

  test('overview', async ({ page }) => {
    await open(page);
    expect(serious(await scan(page))).toEqual([]);
  });

  test('results', async ({ page }) => {
    await open(page);
    await page.locator('#q').fill('6300 mel');
    await press(option(page, '6300 Melrose Ave'));
    await expect(page.locator('.count__n')).toBeVisible();
    expect(serious(await scan(page))).toEqual([]);
  });

  test('camera detail', async ({ page }) => {
    await open(page);
    await page.locator('.all summary').click();
    await page.locator('.all .row').first().click();
    await expect(page.locator('.detail')).toBeVisible();
    expect(serious(await scan(page))).toEqual([]);
  });

  test('drive', async ({ page }) => {
    await mockNetwork(page);
    await page.goto(`/${DRIVE}`);
    await expect(page.locator('#view h1.count')).toContainText('on this route');
    await expect(page.locator('.cam')).toHaveCount(cameras.length);
    expect(serious(await scan(page))).toEqual([]);
  });
});

test.describe('a link that goes nowhere', () => {
  test('the 404 page leads back to the map', async ({ page }) => {
    await page.goto('/404.html');
    await expect(page.locator('h1')).toHaveText('This page does not exist');
    await expect(page.getByRole('link', { name: 'Open the map' })).toHaveAttribute('href', '/');
  });
});
