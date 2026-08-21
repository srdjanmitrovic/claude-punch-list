/**
 * Produce the README's screenshots and the frames for its GIF.
 *
 *     python3 -m http.server 8000        # in one terminal, from the repo root
 *     node tools/make-media.mjs          # in another; needs `npm i -D playwright`
 *     python3 tools/make-gif.py          # turn the frames into docs/media/demo.gif
 *
 * Drives tools/panel-stage.html, so everything in the pictures is the real
 * panel, overlay, picker and collector doing their real work against the demo
 * page; only chrome.* is stood in for. That is what makes the images
 * reproducible: change the panel, rerun this, commit the result.
 *
 * Playwright is not a dependency of the extension and is deliberately not in
 * package.json. Install it locally when you need this, or pass a browser from
 * any Playwright session to run().
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE_URL = process.env.STAGE_URL || 'http://localhost:8000/tools/panel-stage.html';

// Stage geometry, in CSS pixels. The demo tab fills the window left of the
// 380px panel, under a 40px toolbar.
const PANEL_WIDTH = 380;
const TOOLBAR = 40;

const WORDS = {
  total: 'The total shows NaN after applying a coupon. It should show the discounted price.',
  coupon: 'Validate the coupon as you type instead of only on Apply.',
  pay: 'Move the Pay button above the coupon field. Most people never use a coupon.',
};

async function openStage(
  browser,
  { deviceScaleFactor, colorScheme = 'light', width = 1200, height = 720 }
) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    colorScheme,
  });
  const page = await context.newPage();
  await page.exposeFunction('__pwCapture', async () => {
    const png = await page.locator('#demo').screenshot({ animations: 'disabled' });
    return `data:image/png;base64,${png.toString('base64')}`;
  });
  await page.goto(STAGE_URL);
  await page.waitForTimeout(700);

  const panel = () => page.frames().find((frame) => frame.url() === 'about:srcdoc');
  const demo = () => page.frames().find((frame) => frame.url().endsWith('demo-page.html'));
  const centre = async (selector) => {
    const box = await panel().locator(selector).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };

  // Where things are on the demo page, in window coordinates, read from the
  // DOM so the stage can be any size without the pointer missing.
  const spots = async () => {
    const box = (selector) => demo().locator(selector).boundingBox();
    const middle = (b) => [b.x + b.width / 2, b.y + b.height / 2];
    const total = await box('.summary-row.total');
    return {
      apply: middle(await box('#apply')),
      coupon: middle(await box('#coupon')),
      shipping: middle(await box('.summary-row:nth-of-type(2)')),
      // A little air around the row, the way a hand drags.
      totalFrom: [total.x - 14, total.y - 6],
      totalTo: [total.x + total.width + 14, total.y + total.height + 6],
    };
  };

  const demoClip = { x: 0, y: TOOLBAR, width: width - PANEL_WIDTH, height: Math.min(680, height - TOOLBAR) };
  return { context, page, panel, demo, centre, spots, demoClip };
}

/** The pictures the README embeds directly. */
async function stills(browser, outDir) {
  // Tall enough that a three item sheet and the copy button fit without
  // scrolling, as they do in a side panel on a laptop screen, and wide enough
  // that the screen capture stays landscape.
  const { context, page, panel, demo, spots, demoClip } = await openStage(browser, {
    deviceScaleFactor: 2,
    width: 1600,
    height: 1040,
  });
  const clipDemo = { clip: demoClip };
  const at = await spots();

  await demo().locator('#apply').click();
  await page.waitForTimeout(300);

  // Region: caught mid-drag, overlay and readout visible.
  await panel().locator('#mode-region').click();
  await page.waitForTimeout(200);
  await page.mouse.move(...at.totalFrom);
  await page.mouse.down();
  await page.mouse.move(...at.totalTo, { steps: 8 });
  await page.screenshot({ path: join(outDir, 'capture-region.png'), ...clipDemo });
  await page.mouse.up();
  await page.waitForTimeout(900);
  await page.keyboard.type(WORDS.total);

  // Element: the picker hovering a row.
  await panel().locator('#mode-element').click();
  await page.waitForTimeout(200);
  await page.mouse.move(...at.shipping);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(outDir, 'capture-element.png'), ...clipDemo });
  await page.mouse.move(...at.coupon);
  await page.waitForTimeout(150);
  await page.mouse.click(...at.coupon);
  await page.waitForTimeout(900);
  await panel().locator('#intent-change').click();
  await page.keyboard.type(WORDS.coupon);

  await panel().locator('#mode-visible').click();
  await page.waitForTimeout(900);
  await page.keyboard.type(WORDS.pay);
  await page.waitForTimeout(200);

  // The sheet with three items, in both schemes.
  await page.locator('#panel').screenshot({ path: join(outDir, 'panel-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await panel().locator('.row-pick').nth(0).click();
  // The click leaves the pointer over the thumbnail, and a hovered thumbnail
  // shows its tooltip. Park the pointer on the demo page first.
  await page.mouse.move(at.shipping[0], at.shipping[1] + 200);
  await page.waitForTimeout(200);
  await page.locator('#panel').screenshot({ path: join(outDir, 'panel-dark.png') });

  await context.close();
}

/** The GIF, as numbered PNG frames plus the delay to show each one for. */
async function frames(browser, framesDir) {
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const { context, page, panel, centre, spots } = await openStage(browser, { deviceScaleFactor: 1 });
  const on = await spots();
  const durations = [];
  let at = [600, 600];

  const shot = async (ms) => {
    const index = String(durations.length).padStart(3, '0');
    await page.screenshot({ path: join(framesDir, `f${index}.png`) });
    durations.push(ms);
  };
  const pointer = (x, y) => page.evaluate(([px, py]) => window.__stage.pointer(px, py), [x, y]);
  const glide = async (x, y, steps = 7, ms = 45) => {
    const [x0, y0] = at;
    for (let step = 1; step <= steps; step += 1) {
      // Ease out, so the pointer arrives rather than stops.
      const t = 1 - (1 - step / steps) ** 2;
      const px = x0 + (x - x0) * t;
      const py = y0 + (y - y0) * t;
      await page.mouse.move(px, py);
      await pointer(px, py);
      await shot(ms);
    }
    at = [x, y];
  };
  const click = async (hold = 180) => {
    await page.mouse.down();
    await shot(hold);
    await page.mouse.up();
  };
  const type = async (text, chunk = 3, ms = 70) => {
    for (let i = 0; i < text.length; i += chunk) {
      await page.keyboard.type(text.slice(i, i + chunk));
      await shot(ms);
    }
  };

  await pointer(...at);
  await shot(900);

  // The bug happens.
  await glide(...on.apply);
  await click();
  await page.waitForTimeout(300);
  await shot(1100);

  // Item 1: region over the broken total.
  await glide(...(await centre('#mode-region')));
  await click();
  await shot(500);
  await glide(...on.totalFrom, 6);
  await page.mouse.down();
  await shot(120);
  await glide(...on.totalTo, 9, 55);
  await page.mouse.up();
  await page.waitForTimeout(700);
  await shot(700);
  await type(WORDS.total);
  await shot(900);

  // Item 2: the coupon field, as a suggestion.
  await glide(...(await centre('#mode-element')));
  await click();
  await shot(300);
  await glide(...on.coupon, 8);
  await shot(400);
  await click();
  await page.waitForTimeout(700);
  await shot(500);
  await glide(...(await centre('#intent-change')), 5);
  await click();
  await shot(300);
  await type(WORDS.coupon);
  await shot(900);

  // Item 3: the whole screen.
  await glide(...(await centre('#mode-visible')), 5);
  await click();
  await page.waitForTimeout(700);
  await shot(500);
  await type(WORDS.pay);
  await shot(900);

  // One prompt for all of it. The sheet is taller than the window by now, so
  // the panel scrolls until the button sits at the bottom edge, with the sheet
  // just above it, the way a hand on the wheel would. On the way, a pause over
  // the first row.
  await panel().evaluate(() => {
    document.getElementById('submit').scrollIntoView({ block: 'end', behavior: 'instant' });
  });
  await page.waitForTimeout(150);
  await shot(400);
  await glide(...(await centre('.row:first-child .row-pick')), 6);
  await shot(700);
  await glide(...(await centre('#submit')), 6);
  await click();
  await page.waitForTimeout(500);
  await shot(2600);

  writeFileSync(join(framesDir, 'durations.json'), JSON.stringify(durations));
  await context.close();
}

export async function run(browser, outDir = join(ROOT, 'docs', 'media')) {
  mkdirSync(outDir, { recursive: true });
  await stills(browser, outDir);
  await frames(browser, join(outDir, 'frames'));
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import('playwright');
  // PLAYWRIGHT_CHANNEL=chrome uses the installed Google Chrome instead of a
  // downloaded Chromium; PLAYWRIGHT_EXECUTABLE points at any binary.
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
  });
  try {
    const out = await run(browser, process.argv[2] && resolve(process.argv[2]));
    console.log(`wrote stills and frames under ${out}`);
  } finally {
    await browser.close();
  }
}
