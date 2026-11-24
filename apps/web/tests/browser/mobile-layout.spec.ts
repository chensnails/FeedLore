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

async function waitForMotion(page: Page, selector: string) {
  await page.locator(selector).evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

async function openSettings(page: Page) {
  await page.locator('.overflow-btn:visible').first().click();
  await page.locator('.overflow-menu .overflow-item', { hasText: /^设置$/ }).click();
  await expect(page.locator('.settings-modal')).toBeVisible();
}

async function openFirstFeed(page: Page) {
  const group = page.locator('.feed-group-head').first();
  await expect(group).toBeVisible();
  if ((await group.getAttribute('class'))?.includes('collapsed')) await group.click();
  const row = page.locator('.feed-row').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('.ds-sheet')).toBeVisible();
  await waitForMotion(page, '.ds-sheet');
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
  for (const selector of ['.reader-side-fold', '#readerSideClose', '.rd-ch-filter:visible']) {
    const target = await rect(page, selector);
    expect(target.width, selector).toBeGreaterThanOrEqual(44);
    expect(target.height, selector).toBeGreaterThanOrEqual(44);
  }

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
  const copy = await rect(page, '.card-foot .btn-copy');
  expect(copy.width).toBeGreaterThanOrEqual(44);
  expect(copy.height).toBeGreaterThanOrEqual(44);

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

test('桌面键盘：关闭确认框后 Ctrl+K 可打开，卡片搜索 Esc 不失焦', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page);
  await page.locator('#readerReadAllBtn').click();
  await expect(page.locator('.confirm-mask')).toBeVisible();
  await page.locator('.confirm-foot .btn-ghost').click();
  await expect(page.locator('.confirm-mask')).toBeHidden();

  await page.keyboard.press('Control+k');
  await expect(page.locator('.cmdk-mask')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmdk-mask')).toBeHidden();

  await page.locator('.viewnav-btn[data-view="cards"]:visible').click();
  await expect(page.locator('#searchInput')).toBeVisible();
  await page.locator('#searchInput').fill('条目');
  await page.locator('#searchInput').press('Escape');
  await expect(page.locator('#searchInput')).toHaveValue('');
  await expect(page.locator('#searchInput')).toBeFocused();
});

for (const width of [760, 820]) {
  test(`${width}px 设置详情：贴底铺满内容区`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page);
    await openSettings(page);
    await expect(page.locator('.settings-modal')).toHaveClass(/mobile-home/);
    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('.settings-modal')).toHaveClass(/mobile-pane/);
    await openFirstFeed(page);

    const panel = await rect(page, '#settingsPanel');
    const sheet = await rect(page, '.ds-sheet');
    expect(Math.abs(sheet.left - panel.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(sheet.right - panel.right)).toBeLessThanOrEqual(2);
    expect(Math.abs(sheet.bottom - panel.bottom)).toBeLessThanOrEqual(2);
    expect(sheet.width).toBeGreaterThan(panel.width * 0.98);
    await page.locator('.ds-close').click();
    await expect(page.locator('.ds-sheet')).toHaveCount(0);
  });
}

test('821px 设置详情：恢复桌面右侧抽屉', async ({ page }) => {
  await page.setViewportSize({ width: 821, height: 900 });
  await boot(page);
  await openSettings(page);
  await expect(page.locator('.settings-modal')).not.toHaveClass(/mobile-home/);
  await page.locator('.tab[data-tab="source"]').click();
  await openFirstFeed(page);

  const panel = await rect(page, '#settingsPanel');
  const sheet = await rect(page, '.ds-sheet');
  expect(sheet.width).toBeLessThanOrEqual(420);
  expect(sheet.left).toBeGreaterThan(panel.left);
  expect(Math.abs(sheet.right - panel.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(sheet.bottom - panel.bottom)).toBeLessThanOrEqual(2);
});

test('844×390 粗指针横屏：复用移动抽屉与底栏，命中区不压缩', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await boot(page);
  await expect(page.locator('#readerMenuBtn')).toBeVisible();
  await expect(page.locator('#mobileTabbarRoot .viewnav')).toBeVisible();
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--head-h').trim(),
    ),
  ).toBe('38px');

  await page.locator('#readerMenuBtn').tap();
  await expect(page.locator('body')).toHaveClass(/reader-drawer-open/);
  await expect.poll(async () => (await rect(page, '#readerSide')).left).toBeGreaterThanOrEqual(0);
  const drawer = await rect(page, '#readerSide');
  expect(drawer.width).toBeLessThanOrEqual(272);
  for (const selector of ['.reader-side-fold', '#readerSideClose', '.rd-ch-filter:visible']) {
    const target = await rect(page, selector);
    expect(target.width, selector).toBeGreaterThanOrEqual(44);
    expect(target.height, selector).toBeGreaterThanOrEqual(44);
  }
  await page.locator('#readerSideClose').tap();
  await expect(page.locator('body')).not.toHaveClass(/reader-drawer-open/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
