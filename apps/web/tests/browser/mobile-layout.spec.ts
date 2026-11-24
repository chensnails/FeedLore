import { expect, type Page, test } from '@playwright/test';

type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

async function rect(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} 应有可见几何`).not.toBeNull();
  return {
    left: box!.x,
    top: box!.y,
    right: box!.x + box!.width,
    bottom: box!.y + box!.height,
    width: box!.width,
    height: box!.height,
  };
}

async function touchSwipe(page: Page, from: [number, number], to: [number, number]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from[0], y: from[1] }],
  });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from[0] + ((to[0] - from[0]) * step) / 6,
          y: from[1] + ((to[1] - from[1]) * step) / 6,
        },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function boot(page: Page) {
  await page.goto('/');
  await expect.poll(() => page.locator('#readerList .art-item').count()).toBeGreaterThanOrEqual(20);
  await expect(page.locator('#readerTitle')).toContainText('全部');
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  (page as Page & { __browserErrors?: string[] }).__browserErrors = errors;
});

test.afterEach(async ({ page }) => {
  const errors = (page as Page & { __browserErrors?: string[] }).__browserErrors || [];
  expect(errors, '真实浏览器不应有未捕获异常或控制台错误').toEqual([]);
});

test('720px 文章页：触控展开正文、频道抽屉与底栏均在视口内', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#mobileTabbarRoot .viewnav')).toBeVisible();
  await expect(page.locator('#readerMenuBtn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const menu = await rect(page, '#readerMenuBtn');
  expect(menu.height).toBeGreaterThanOrEqual(36);
  await page.locator('#readerMenuBtn').tap();
  await expect(page.locator('body')).toHaveClass(/reader-drawer-open/);
  await expect.poll(async () => (await rect(page, '#readerSide')).left).toBeGreaterThanOrEqual(0);
  const drawer = await rect(page, '#readerSide');
  expect(drawer.left).toBeGreaterThanOrEqual(0);
  expect(drawer.right).toBeLessThanOrEqual(720);
  expect(drawer.width).toBeLessThan(720);

  await page.locator('#readerSideClose').tap();
  await expect(page.locator('body')).not.toHaveClass(/reader-drawer-open/);
  await page.locator('.art-head').first().tap();
  await expect(page.locator('.art-item.open .art-inner p').first()).toBeVisible();
  await expect(page.locator('.art-head').first()).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.art-head').first().tap();
  await expect(page.locator('.art-item.open')).toHaveCount(0);

  const nav = await rect(page, '#mobileTabbarRoot .viewnav');
  expect(nav.left).toBeGreaterThanOrEqual(0);
  expect(nav.right).toBeLessThanOrEqual(720);
  expect(nav.top).toBeGreaterThanOrEqual(0);
  expect(nav.bottom).toBeLessThanOrEqual(900);
});

test('720px 卡片页保持至少两列，详情层不溢出', async ({ page }) => {
  await boot(page);
  await page.locator('#mobileTabbarRoot [data-view="cards"]').tap();
  await expect(page.locator('#cardsView')).toBeVisible();
  await expect.poll(() => page.locator('#grid > .card').count()).toBeGreaterThanOrEqual(20);
  const columns = await page.locator('#grid').evaluate((element) => {
    const grid = element as HTMLElement;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  });
  expect(columns).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.locator('#grid > .card .title-btn').first().tap();
  await expect(page.locator('.cd-modal')).toBeVisible();
  await expect
    .poll(async () => {
      const current = await rect(page, '.cd-modal');
      return current.left >= 0 && current.right <= 720 && current.bottom <= 900;
    })
    .toBe(true);
  const sheet = await rect(page, '.cd-modal');
  expect(sheet.left).toBeGreaterThanOrEqual(0);
  expect(sheet.right).toBeLessThanOrEqual(720);
  expect(sheet.top).toBeGreaterThanOrEqual(0);
});

test('720px 设置层：输入字号、下滑不关闭、右滑不打开抽屉', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => history.pushState({}, '', location.href));
  await page.locator('.overflow-btn:visible').first().tap();
  await page.locator('.overflow-menu .overflow-item', { hasText: /^设置$/ }).tap();
  await expect(page.locator('.settings-modal')).toBeVisible();
  await expect
    .poll(async () => {
      const current = await rect(page, '.settings-modal');
      return current.left >= 0 && current.right <= 720 && current.bottom <= 900;
    })
    .toBe(true);
  const modal = await rect(page, '.settings-modal');
  expect(modal.left).toBeGreaterThanOrEqual(0);
  expect(modal.right).toBeLessThanOrEqual(720);
  expect(modal.top).toBeGreaterThanOrEqual(0);

  const fontSize = await page
    .locator('.settings-modal input:not([type="checkbox"]):not([type="radio"])')
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);

  await touchSwipe(page, [40, 420], [40, 760]);
  await expect(page.locator('.settings-modal')).toBeVisible();
  await touchSwipe(page, [240, 620], [500, 620]);
  await expect(page.locator('body')).not.toHaveClass(/reader-drawer-open/);
  expect(page.url()).not.toBe('about:blank');
});

test('721px 越过断点：频道回到常驻侧栏，底栏隐藏', async ({ page }) => {
  await page.setViewportSize({ width: 721, height: 900 });
  await boot(page);
  await expect(page.locator('#readerMenuBtn')).toBeHidden();
  await expect(page.locator('#mobileTabbarRoot')).toBeHidden();
  const side = await rect(page, '#readerSide');
  expect(side.left).toBeGreaterThanOrEqual(0);
  expect(side.width).toBeGreaterThan(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
