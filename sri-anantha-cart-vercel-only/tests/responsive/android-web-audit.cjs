// Android app layout check on the React Native web build (Expo export served at :8099), at phone and
// tablet widths. This approximates Android layout (same React Native flexbox), but it is NOT a device
// test: fonts, density buckets, status/navigation bars and gestures still need an emulator or phone.
//   node tests/responsive/android-web-audit.cjs [baseUrl]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const devices = [
  { name: 'small-320', width: 320, height: 640, dpr: 2 },     // small/older Android phones
  { name: 'standard-360', width: 360, height: 780, dpr: 3 },  // most common Android width
  { name: 'large-412', width: 412, height: 915, dpr: 2.6 },   // Pixel / large phones
  { name: 'tablet-768', width: 768, height: 1024, dpr: 2 },
  { name: 'landscape-780', width: 780, height: 360, dpr: 3 },
];
const routes = ['/', '/categories', '/c/pooja-essentials', '/products/brass-diya', '/search?q=diya', '/cart', '/login'];
const shots = path.join(__dirname, 'shots', 'android-web');
fs.mkdirSync(shots, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const rows = [];
  for (const device of devices) {
    const context = await browser.newContext({ viewport: { width: device.width, height: device.height }, deviceScaleFactor: device.dpr, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    // Dismiss the first-run tour / PIN dialog if shown.
    for (const label of ['Skip', 'Continue shopping']) { const b = page.locator(`text="${label}" >> visible=true`).first(); if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(300); } }
    for (const route of routes) {
      await page.goto(base + route, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(900);
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const visible = el => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0; };
        const inScroller = el => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
        const off = []; const small = []; const clipped = [];
        for (const el of document.querySelectorAll('body *')) {
          if (!visible(el)) continue;
          const b = el.getBoundingClientRect();
          if (b.right > vw + 1 && b.left < vw && !inScroller(el)) off.push(`${el.textContent?.trim().slice(0, 24)} r=${Math.round(b.right)}`);
          if ((el.getAttribute('role') === 'button' || el.tagName === 'BUTTON' || el.tagName === 'A') && (b.height < 40 || b.width < 40)) small.push(`${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)} ${Math.round(b.width)}×${Math.round(b.height)}`);
          // React Native Text with numberOfLines renders -webkit-line-clamp; anything else cut off is a defect.
          const s = getComputedStyle(el);
          if (el.children.length === 0 && el.textContent.trim() && s.overflow === 'hidden' && !/\d/.test(s.webkitLineClamp || '') && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) clipped.push(el.textContent.trim().slice(0, 24));
        }
        return { overflow: document.documentElement.scrollWidth - vw, off: [...new Set(off)].slice(0, 5), small: [...new Set(small)].slice(0, 6), clipped: [...new Set(clipped)].slice(0, 5) };
      });
      rows.push({ device: device.name, route, ...r });
      await page.screenshot({ path: path.join(shots, `${device.name}${route.replace(/[/?=]/g, '_')}.png`) });
    }
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'results-android-web.json'), JSON.stringify(rows, null, 1));
  const bad = rows.filter(r => r.overflow > 0 || r.off.length || r.clipped.length);
  for (const r of bad) console.log(r.device, r.route, `overflow=${r.overflow}`, JSON.stringify({ off: r.off, clipped: r.clipped }));
  const small = {}; for (const r of rows) for (const s of r.small) { const k = s.replace(/ \d+×\d+$/, ''); (small[k] ??= new Set()).add(`${r.device}:${s.match(/\d+×\d+$/)[0]}`); }
  console.log(`Small touch targets: ${Object.keys(small).length}`); for (const [k, v] of Object.entries(small)) console.log(`  "${k}" ${[...v].slice(0, 3).join(' ')}`);
  console.log(`${rows.length} screens, ${bad.length} with layout defects.`);
})();
