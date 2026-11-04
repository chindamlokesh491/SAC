// Browser checks for the advanced catalogue filters (desktop and a phone viewport).
// Runs against the same live stack as storefront-admin.e2e.cjs (API + web + demo catalogue).
// Needs only E2E_BASE_URL (default http://localhost:3000); skipped unless E2E_OTP_OUTBOX is set,
// which is how the CI e2e job and local stack runs signal that a stack is running.
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { chromium } = require('playwright');

const base = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const skip = !process.env.E2E_OTP_OUTBOX ? 'Set E2E_OTP_OUTBOX (live stack) to run browser E2E tests' : false;

const shownTotal = async page => {
  const text = await page.locator('.listing-head p').first().innerText();
  if (/No products found/.test(text)) return 0;
  const match = /of (\d+) products/.exec(text);
  assert.ok(match, `unexpected listing summary: ${text}`);
  return Number(match[1]);
};

// Returning visitor: the first-visit tour and PIN prompt are covered in storefront-admin.e2e.cjs.
const returning = async (browser, options = {}) => {
  const context = await browser.newContext(options);
  await context.addInitScript(() => { localStorage.setItem('sac-guest-tour-done', '1'); localStorage.setItem('sac-pin-asked', '1'); });
  return { context, page: await context.newPage() };
};

describe('catalogue filters (browser)', { skip }, () => {
  let browser;
  let category;
  before(async () => {
    browser = await chromium.launch();
    const categories = await (await fetch(`${base}/api/v1/categories`)).json();
    category = categories.data.find(item => item.product_count > 1) ?? categories.data[0];
    assert.ok(category, 'demo catalogue must contain a category');
  });
  after(async () => { await browser?.close(); });

  it('shows live facet counts and applies the On sale filter on a category page', async () => {
    const facets = (await (await fetch(`${base}/api/v1/products/filters?category=${category.slug}`)).json()).data;
    const { context, page } = await returning(browser);
    await page.goto(`${base}/c/${category.slug}`, { waitUntil: 'networkidle' });
    assert.equal(await shownTotal(page), facets.counts.total);
    await page.getByText(`Products with a discount (${facets.counts.discounted})`).waitFor();
    await page.getByText(`Only items available to order (${facets.counts.in_stock})`).waitFor();

    // The checkbox is controlled by the URL, so it reflects the new state after client navigation.
    const onSale = page.locator('label.filter-option', { hasText: 'On sale' }).locator('input');
    await onSale.click();
    await page.waitForURL(/discount_only=true/);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.querySelectorAll('label.filter-option input')[1]?.checked === true);
    assert.equal(await shownTotal(page), facets.counts.discounted);

    // Clear all removes every filter from the URL.
    await page.getByRole('button', { name: 'Clear all' }).click();
    await page.waitForURL(url => !url.search.includes('discount_only'));
    await page.waitForLoadState('networkidle');
    assert.equal(await shownTotal(page), facets.counts.total);
    await context.close();
  });

  it('rejects an inverted price range without navigating', async () => {
    const { context, page } = await returning(browser);
    await page.goto(`${base}/c/${category.slug}`, { waitUntil: 'networkidle' });
    await page.getByLabel('Minimum price').fill('500');
    await page.getByLabel('Maximum price').fill('100');
    await page.getByRole('alert').filter({ hasText: 'Minimum price must not exceed maximum price' }).waitFor();
    await page.getByRole('button', { name: 'Apply price range' }).click();
    await page.waitForTimeout(500);
    assert.ok(!page.url().includes('min='), 'an invalid range must not be applied');
    await context.close();
  });

  it('opens the filter panel from the Filters button on a phone viewport', async () => {
    const { context, page } = await returning(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`${base}/c/${category.slug}?discount_only=true`, { waitUntil: 'networkidle' });
    const button = page.locator('button.filter-open');
    await button.waitFor();
    assert.match(await button.innerText(), /Filters · 1/);
    await button.click();
    assert.match(await page.locator('#listing-filters').getAttribute('class'), /\bopen\b/);
    await context.close();
  });
});
