// Browser tests. Run: npx playwright test
import { test, expect } from '@playwright/test';
import { mockNetwork, expectedNear, PLACES, SAN_FRANCISCO, cameras } from './mocks.js';
import { open, press, origin, isSheet, option } from './helpers.js';

const on = cameras.filter((c) => c.status !== 'Under Construction').length;

/** Type an address and pick a suggestion. */
async function search(page, typed, pick) {
  await page.locator('#q').fill(typed);
  await press(option(page, pick));
  await expect(page.locator('.count__n')).toBeVisible();
}

async function enter(page, typed) {
  await page.locator('#q').fill(typed);
  await page.locator('#q').press('Enter');
}

test.describe('overview', () => {
  test('shows every camera and where the data came from', async ({ page }) => {
    const { errors } = await open(page);
    await expect(page.locator('#view h1')).toHaveText('Speed cameras in Los Angeles');
    await expect(page.locator('.lede')).toContainText(`The city plans ${cameras.length} cameras. LADOT lists ${on} as active.`);
    await expect(page.locator('.legend li')).toHaveCount(2);
    await expect(page.locator('#foot .source')).toContainText("LADOT's map, last changed Nov 6, 2026");
    await expect(page.locator('#foot .source')).toContainText('This is not a city website');
    expect(errors).toEqual([]);
  });

  test('nothing spills off the screen', async ({ page }) => {
    await open(page);
    const box = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, w: innerWidth, h: innerHeight,
      search: document.querySelector('#search').getBoundingClientRect().toJSON(),
      panel: document.querySelector('#panel').getBoundingClientRect().toJSON(),
    }));
    expect(box.scroll).toBeLessThanOrEqual(box.w);
    expect(box.search.left).toBeGreaterThanOrEqual(0);
    expect(box.search.right).toBeLessThanOrEqual(box.w);
    expect(box.panel.right).toBeLessThanOrEqual(box.w);
    expect(box.panel.bottom).toBeLessThanOrEqual(box.h + 1);
    expect(box.panel.height).toBeGreaterThan(100);
  });

  test('the panel leaves room for the map', async ({ page }) => {
    await open(page);
    const share = await page.evaluate(() => {
      const p = document.querySelector('#panel').getBoundingClientRect();
      const s = document.querySelector('#search').getBoundingClientRect();
      return ((p.width * p.height) + (s.width * s.height)) / (innerWidth * innerHeight);
    });
    expect(share).toBeLessThan(0.5);
  });

  test('every control has a name', async ({ page }) => {
    await open(page);
    const nameless = await page.evaluate(() => [...document.querySelectorAll('button, a, input')]
      .filter((n) => !(n.getAttribute('aria-label') || n.textContent.trim() || n.labels?.length))
      .map((n) => n.outerHTML.slice(0, 80)));
    expect(nameless).toEqual([]);
    await expect(page.locator('#status')).toHaveAttribute('role', 'status');
    await expect(page.locator('#view h1')).toHaveCount(1);
    await expect(page.locator('.cam__btn').first()).toHaveAttribute('aria-label', /^Camera on .+ mph limit\. /);
  });

  test('the all-cameras list opens a camera without the map', async ({ page }) => {
    await open(page);
    await page.locator('.all summary').click();
    await expect(page.locator('.all .row')).toHaveCount(cameras.length);
    await page.locator('.all .row').filter({ hasText: 'S La Cienega Blvd' }).filter({ hasText: 'Coliseum St' }).click();
    await expect(page.locator('#view h1')).toHaveText('S La Cienega Blvd');
    // LADOT's two sources disagree on this limit. The page shows both.
    await expect(page.locator('.facts')).toContainText('35 or 45 mph');
    await expect(page.locator('.facts')).toContainText('46 or 56 mph');
    await press(page.locator('.back'));
    await expect(page.locator('.all')).toHaveAttribute('open', '');
  });
});

test.describe('search', () => {
  test('counts the cameras near a picked address', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
    await expect(page.locator('#view h1')).toContainText('within 2 miles of 6300 Melrose Ave, Los Angeles');
    await expect(page.locator('#view h1')).toBeFocused();
    await expect(page.locator('#status')).toHaveText(`${expectedNear(PLACES.melrose, 2)} cameras within 2 miles of 6300 Melrose Ave, Los Angeles.`);
    await expect(page.locator('#q')).toHaveValue('6300 Melrose Ave, Los Angeles');
    await expect(page.locator('#view .cams').first().locator('.row')).toHaveCount(expectedNear(PLACES.melrose, 2));
    expect((await origin(page)).district).not.toBeNull();
  });

  test('each distance shows its own count', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    for (const miles of [5, 1, 2]) {
      await press(page.getByRole('radio', { name: miles === 1 ? '1 mile' : `${miles} miles` }));
      await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, miles)));
      await expect(page.locator('#view h1')).toContainText(miles === 1 ? 'within 1 mile' : `within ${miles} miles`);
    }
    expect(expectedNear(PLACES.melrose, 1)).toBeLessThan(expectedNear(PLACES.melrose, 5));
  });

  test('Enter takes one strong match', async ({ page }) => {
    await open(page);
    await enter(page, '6300 Melrose Ave');
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
    expect((await origin(page)).label).toBe('6300 Melrose Ave, Los Angeles');
  });

  test('Enter does not guess between three cities', async ({ page }) => {
    await open(page);
    await enter(page, '1234 W 23rd St');
    await expect(page.locator('.suggest__note')).toHaveText('More than one match. Pick one.');
    await expect(page.locator('#suggest [role="option"]')).toHaveCount(3);
    expect(await origin(page)).toBeNull();
    await press(option(page, 'Long Beach'));
    await expect(page.locator('.count__n')).toBeVisible();
    expect((await origin(page)).label).toBe('1234 W 23rd St, Long Beach');
  });

  test('Enter offers both when two suggestions fit', async ({ page }) => {
    await open(page);
    await enter(page, '1234 hobart');
    await expect(page.locator('.suggest__note')).toHaveText('More than one match. Pick one.');
    await expect(page.locator('#suggest [role="option"]')).toHaveCount(2);
    expect(await origin(page)).toBeNull();
  });

  test('Enter never lands on a street far away with a like name', async ({ page }) => {
    await open(page);
    await enter(page, 'The Grove');
    await expect(page.locator('.count__n')).toBeVisible();
    expect((await origin(page)).label).toBe('The Grove Dr, Los Angeles'); // not "The Groves, Palmdale"
  });

  test('nonsense gets a note, not a place', async ({ page }) => {
    await open(page);
    await enter(page, 'zzqqxx blorp 99');
    await expect(page.locator('.suggest__note')).toHaveText('No exact match. Pick the closest one, or check the spelling.');
    expect(await origin(page)).toBeNull();
    await enter(page, '!!!');
    await expect(page.locator('.suggest__note')).toContainText('No address found in Los Angeles County');
    await expect(page.locator('#suggest [role="option"]')).toHaveCount(0);
    expect(await origin(page)).toBeNull();
    await expect(page.locator('#view h1')).toHaveText('Speed cameras in Los Angeles');
  });

  test('an address outside the city says so', async ({ page }) => {
    await open(page);
    await search(page, '1685 main', '1685 Main St');
    await expect(page.locator('.count__n')).toHaveText('0');
    await expect(page.locator('.notice')).toContainText('outside the City of Los Angeles');
    await expect(page.locator('.mix')).toContainText(/The closest camera is [\d.]+ mi away, on /);
    await expect(page.locator('#view h2')).toHaveText('Closest cameras');
    expect((await origin(page)).district).toBeNull();
  });

  test('clear goes back to the overview', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    await press(page.locator('#clear'));
    await expect(page.locator('#view h1')).toHaveText('Speed cameras in Los Angeles');
    await expect(page.locator('#q')).toHaveValue('');
    await expect(page.locator('#clear')).toBeHidden();
    expect(await origin(page)).toBeNull();
  });

  test('an edit cancels a pick that is still loading', async ({ page }) => {
    await open(page, { locateDelay: 700 });
    await page.locator('#q').fill('6300 mel');
    await press(option(page, '6300 Melrose Ave'));
    await page.locator('#q').fill('20'); // the person types again before the position arrives
    await page.waitForTimeout(1100);
    expect(await origin(page)).toBeNull();
    await expect(page.locator('#view h1')).toHaveText('Speed cameras in Los Angeles');
    await expect(page.locator('#q')).toHaveValue('20');
  });

  test('a closed list stays closed when a late answer arrives', async ({ page }) => {
    await open(page);
    await page.locator('#q').fill('6300 mel');
    await page.locator('#q').press('Escape'); // before the 240 ms wait ends
    await page.waitForTimeout(600);
    await expect(page.locator('#suggest')).toBeHidden();
  });
});

test.describe('camera detail', () => {
  test('opens from the list and comes back to the same row', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    const row = page.locator('#view .cams .row').first();
    const street = await row.locator('strong').innerText();
    await press(row);
    await expect(page.locator('#view h1')).toHaveText(street);
    await expect(page.locator('#view h1')).toBeFocused();
    await expect(page.locator('.facts')).toContainText('Tickets start at');
    await expect(page.locator('.facts')).toContainText('From the address');
    await expect(page.locator('.cam.is-selected')).toHaveCount(1);
    await expect(page.locator('.cam.is-selected .cam__btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('link', { name: 'Open in Google Maps' })).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=-?[\d.]+,-?[\d.]+$/);
    await press(page.locator('.back'));
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
    await expect(page.locator('#view .cams .row').first()).toBeFocused();
    await expect(page.locator('.cam.is-selected')).toHaveCount(0);
  });

  test('opens from a marker on the map', async ({ page }) => {
    await open(page);
    // Press a marker that nothing covers.
    const label = await page.evaluate(() => {
      const free = [...document.querySelectorAll('.cam__btn')].find((b) => {
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top && b.contains(top);
      });
      free.click();
      return free.getAttribute('aria-label');
    });
    const street = label.match(/^Camera on (.+?), /)[1];
    await expect(page.locator('#view h1')).toHaveText(street);
    await expect(page.locator('.back')).toContainText('All cameras');
    await press(page.locator('.back'));
    await expect(page.locator('#view h1')).toHaveText('Speed cameras in Los Angeles');
  });

  test('the open camera stays in view when the screen turns', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    await press(page.locator('#view .cams .row').first());
    const size = page.viewportSize();
    for (const turned of [{ width: size.height, height: size.width }, size]) {
      await page.setViewportSize(turned);
      await page.waitForTimeout(700);
      const seen = await page.evaluate(() => {
        const r = document.querySelector('.cam.is-selected .cam__btn').getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const cover = (sel) => {
          const b = document.querySelector(sel).getBoundingClientRect();
          return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
        };
        return { x, y, w: innerWidth, h: innerHeight, underPanel: cover('#panel'), underSearch: cover('#search') };
      });
      expect(seen.x).toBeGreaterThan(0);
      expect(seen.x).toBeLessThan(seen.w);
      expect(seen.y).toBeGreaterThan(0);
      expect(seen.y).toBeLessThan(seen.h);
      expect(seen.underPanel).toBe(false);
      expect(seen.underSearch).toBe(false);
    }
  });
});

test.describe('map markers', () => {
  test('signs never cover each other', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    await press(page.getByRole('radio', { name: '5 miles' }));
    await page.waitForTimeout(1500); // the map settles
    const result = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.cam.is-sign .sign')].map((n) => n.getBoundingClientRect());
      let clashes = 0;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) clashes += 1;
        }
      }
      return { signs: boxes.length, clashes };
    });
    expect(result.signs).toBeGreaterThan(0);
    expect(result.clashes).toBe(0);
  });

  test('markers off the screen leave the tab order', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    await press(page.getByRole('radio', { name: '1 mile' }));
    await page.waitForTimeout(1500);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.cam__btn')].map((b) => {
      const r = b.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      return { tab: b.tabIndex, x, y, inView: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight };
    }));
    expect(tabs.some((t) => !t.inView)).toBe(true);
    expect(tabs.some((t) => t.inView)).toBe(true);
    // A marker within 2 px of the edge may round either way. Any other mismatch is a bug.
    const size = page.viewportSize();
    const onEdge = (t) => Math.min(Math.abs(t.x), Math.abs(t.x - size.width), Math.abs(t.y), Math.abs(t.y - size.height)) <= 2;
    expect(tabs.filter((t) => (t.tab === 0) !== t.inView && !onEdge(t))).toEqual([]);
  });
});

test.describe('LADOT data', () => {
  test('LADOT down: the saved copy shows, and says it is a copy', async ({ page }) => {
    await open(page, { ladot: 'down' });
    await expect(page.locator('#foot .source')).toContainText('Camera data: a copy of');
    await expect(page.locator('#foot .source')).toContainText('A status may be out of date');
    await expect(page.locator('.lede')).toContainText(`LADOT lists ${on} as active`);
    await search(page, '6300 mel', '6300 Melrose Ave');
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
  });

  test('LADOT renames its status field: the saved copy stays', async ({ page }) => {
    await open(page, { change: ({ System, ...rest }) => ({ ...rest, Status: System }) });
    await expect(page.locator('#foot .source')).toContainText('Camera data: a copy of');
    await expect(page.locator('.lede')).toContainText(`LADOT lists ${on} as active`);
    await expect(page.locator('.lede')).not.toContainText('all');
  });

  test('a status the app has never seen shows in LADOT\'s words, and does not count as active', async ({ page }) => {
    await open(page, { change: (p) => ({ ...p, System: 'Paused For Repair' }) });
    await expect(page.locator('.lede')).toContainText('LADOT lists none as active yet');
    await expect(page.locator('.legend')).toContainText('Paused For Repair');
    await expect(page.locator('.legend__n')).toHaveText(String(cameras.length));
  });

  test('"Citation Live" reads as issuing tickets', async ({ page }) => {
    await open(page, { change: (p) => ({ ...p, System: 'Citation Live' }) });
    await expect(page.locator('.lede')).toContainText(`LADOT lists all ${cameras.length} city cameras as active.`);
    await expect(page.locator('.legend')).toContainText('Issuing tickets');
    await search(page, '6300 mel', '6300 Melrose Ave');
    await expect(page.locator('.mix')).toContainText(/(is|are) issuing tickets\./);
  });

  test('status text from LADOT cannot inject markup', async ({ page }) => {
    const evil = '<img src=x onerror="window.__xss=1"><b>bold</b>';
    await open(page, { change: (p) => ({ ...p, System: evil, StreetName: p.StreetName }) });
    await expect(page.locator('.legend')).toContainText(evil);
    await search(page, '6300 mel', '6300 Melrose Ave');
    await expect(page.locator('.mix')).toContainText('<img src=x');
    await press(page.locator('#view .cams .row').first());
    await expect(page.locator('.facts')).toContainText('<img src=x');
    expect(await page.locator('#view img, #view b:not(.sign b)').count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

test.describe('address finders', () => {
  test('county finder down: Photon answers, and the list says search is limited', async ({ page }) => {
    await open(page, { county: 'down' });
    await page.locator('#q').fill('dodger stadium');
    await expect(page.locator('.suggest__note')).toHaveText('Address search is limited right now. Results can be less exact.');
    await press(option(page, 'Dodger Stadium'));
    await expect(page.locator('.count__n')).toBeVisible();
    expect((await origin(page)).label).toBe('Dodger Stadium, Los Angeles');
  });

  test('a place the county finder lacks comes from Photon', async ({ page }) => {
    await open(page);
    await enter(page, 'dodger stadium');
    await expect(page.locator('.count__n')).toBeVisible();
    expect((await origin(page)).label).toBe('Dodger Stadium, Los Angeles');
  });

  test('both finders down: a plain note', async ({ page }) => {
    await open(page, { county: 'down', photon: 'down' });
    await page.locator('#q').fill('6300 mel');
    await expect(page.locator('.suggest__note')).toHaveText('Address search did not answer. Try again in a moment.');
    await page.locator('#q').press('Enter');
    await expect(page.locator('.suggest__note')).toHaveText('Address search did not answer. Try again in a moment.');
    expect(await origin(page)).toBeNull();
  });

  test('the page calls only the hosts it should', async ({ page }) => {
    const { calls } = await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    const hosts = [...new Set(calls.map((u) => new URL(u).hostname))].sort();
    for (const host of hosts) {
      expect(['geocode.gis.lacounty.gov', 'photon.komoot.io', 'services.arcgis.com', 'tiles.openfreemap.org']).toContain(host);
    }
    expect(hosts).toContain('services.arcgis.com');
    expect(hosts).toContain('geocode.gis.lacounty.gov');
  });
});

test.describe('location button', () => {
  test.use({ permissions: ['geolocation'] });

  test('counts cameras near the person', async ({ page, context }) => {
    await context.setGeolocation({ latitude: PLACES.melrose.lat, longitude: PLACES.melrose.lon });
    await open(page);
    await press(page.locator('#locate'));
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
    await expect(page.locator('#view h1')).toContainText('of your location');
    await expect(page.locator('#q')).toHaveValue('Your location');
  });

  test('far from Los Angeles it says how far, and shows the city', async ({ page, context }) => {
    await context.setGeolocation({ latitude: SAN_FRANCISCO.lat, longitude: SAN_FRANCISCO.lon });
    await open(page);
    await press(page.locator('#locate'));
    await expect(page.locator('.notice')).toContainText(/about \d{3} miles from the nearest Los Angeles camera/);
    await expect(page.locator('.count__n')).toHaveText('0');
    await page.waitForTimeout(1200);
    const inView = await page.evaluate(() => [...document.querySelectorAll('.cam__btn')].filter((b) => b.tabIndex === 0).length);
    expect(inView).toBeGreaterThan(60); // the map shows the city, not empty land
  });
});

test.describe('keyboard', () => {
  test('arrow keys pick a suggestion, Escape and Tab close the list', async ({ page }) => {
    await open(page);
    const input = page.locator('#q');
    await input.fill('1234 hob');
    await expect(page.locator('#suggest [role="option"]')).toHaveCount(2);
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'place-1');
    await expect(page.locator('#place-1')).toHaveAttribute('aria-selected', 'true');
    await input.press('Escape');
    await expect(page.locator('#suggest')).toBeHidden();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/);

    await input.fill('1234 hob');
    await expect(page.locator('#suggest [role="option"]')).toHaveCount(2);
    await input.press('Tab');
    await expect(page.locator('#suggest')).toBeHidden();

    await input.fill('1234 hob');
    await expect(page.locator('#suggest [role="option"]')).toHaveCount(2);
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(page.locator('.count__n')).toBeVisible();
    expect((await origin(page)).label).toBe('1234 S Hobart Blvd, Los Angeles');
  });

  test('typing again forgets the highlighted suggestion', async ({ page }) => {
    await open(page);
    const input = page.locator('#q');
    await input.fill('1234 hob');
    await expect(page.locator('#suggest [role="option"]')).toHaveCount(2);
    await input.press('ArrowDown');
    await input.pressSequentially('a');
    await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/);
  });

  test('arrow keys move through the distances and keep focus', async ({ page }) => {
    await open(page);
    await search(page, '6300 mel', '6300 Melrose Ave');
    const checked = page.locator('.seg [aria-checked="true"]');
    await expect(page.locator('.seg [tabindex="0"]')).toHaveCount(1);
    await checked.focus();
    await page.keyboard.press('ArrowRight');
    await expect(checked).toHaveText('5 miles');
    await expect(checked).toBeFocused();
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(checked).toHaveText('1 mile');
    await page.keyboard.press('ArrowLeft'); // wraps back
    await expect(checked).toHaveText('5 miles');
    await page.keyboard.press('ArrowUp');
    await expect(checked).toHaveText('2 miles');
    await expect(checked).toBeFocused();
  });
});

test.describe('phone sheet', () => {
  test('the grip steps through three sizes, by tap and by key', async ({ page }) => {
    await open(page);
    test.skip(!(await isSheet(page)), 'this screen uses the side panel');
    const height = () => page.evaluate(() => Math.round(document.querySelector('#panel').getBoundingClientRect().height));
    const settle = () => page.waitForTimeout(450);
    const grip = page.locator('#grip');
    const small = await height();
    await expect(grip).toHaveAttribute('aria-label', /Panel size: small/);
    await press(grip);
    await settle();
    const medium = await height();
    expect(medium).toBeGreaterThan(small);
    await expect(grip).toHaveAttribute('aria-label', /Panel size: medium/);
    await grip.focus();
    await page.keyboard.press('Enter');
    await settle();
    const large = await height();
    expect(large).toBeGreaterThan(medium);
    await page.keyboard.press('Enter');
    await settle();
    expect(await height()).toBe(small);
    await page.keyboard.press('ArrowUp');
    await settle();
    expect(await height()).toBe(medium);
  });

  test('a drag settles on a size, and the tap that ends it does not step again', async ({ page }) => {
    await open(page);
    test.skip(!(await isSheet(page)), 'this screen uses the side panel');
    const sheet = () => page.evaluate(() => window.__app.state.sheet);
    const box = await page.locator('#grip').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 150, { steps: 6 });
    await page.waitForTimeout(150); // the finger rests: no flick
    await page.mouse.up();
    await page.waitForTimeout(450);
    expect(await sheet()).toBe('half');
  });

  test('the list scrolls to its end inside the sheet', async ({ page }) => {
    await open(page);
    test.skip(!(await isSheet(page)), 'this screen uses the side panel');
    await search(page, '6300 mel', '6300 Melrose Ave');
    await page.locator('#foot .source').scrollIntoViewIfNeeded();
    await expect(page.locator('#foot .source')).toBeInViewport();
  });

  test('the search bar sits above the sheet at every size', async ({ page }) => {
    await open(page);
    test.skip(!(await isSheet(page)), 'this screen uses the side panel');
    for (let i = 0; i < 3; i++) {
      const gap = await page.evaluate(() =>
        document.querySelector('#panel').getBoundingClientRect().top - document.querySelector('#search').getBoundingClientRect().bottom);
      expect(gap).toBeGreaterThanOrEqual(0);
      await press(page.locator('#grip'));
      await page.waitForTimeout(450);
    }
  });
});

test.describe('map tiles', () => {
  test('tiles down: the page says so, and counts still work', async ({ page }) => {
    test.setTimeout(45_000);
    await open(page, { tiles: 'down' });
    await expect(page.locator('.notice')).toContainText('The street map did not load', { timeout: 15_000 });
    await search(page, '6300 mel', '6300 Melrose Ave');
    await expect(page.locator('.count__n')).toHaveText(String(expectedNear(PLACES.melrose, 2)));
    await expect(page.locator('.notice')).toContainText('The street map did not load');
  });
});
