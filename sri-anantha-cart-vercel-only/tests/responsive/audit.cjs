// Responsive audit: loads each page at 10 viewport widths and reports measurable layout defects.
//   node tests/responsive/audit.cjs storefront [baseUrl]        (default http://localhost:3000)
//   ADMIN_PHONE=.. ADMIN_PASSWORD=.. node tests/responsive/audit.cjs admin [baseUrl]   (default http://localhost:3001)
// Checks: horizontal page overflow, elements extending past the right edge (outside deliberate scrollers),
// interactive controls smaller than 40×40 px (inline text links excluded), clipped single-line text,
// images without dimensions, and fixed/sticky elements covering buttons. Screenshots: tests/responsive/shots/.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2] === 'admin' ? 'admin' : 'storefront';
const base = (process.argv[3] || (target === 'admin' ? 'http://localhost:3001' : 'http://localhost:3000')).replace(/\/$/, '');
const widths = [320, 360, 375, 390, 412, 430, 768, 1024, 1280, 1440];
const pages = target === 'admin'
  ? ['/admin', '/admin/orders', '/admin/products', '/admin/products/new', '/admin/categories', '/admin/customers', '/admin/inventory', '/admin/payments', '/admin/delivery', '/admin/reports', '/admin/settings', '/admin/account']
  : ['/', '/categories', '/c/pooja-essentials', '/products/brass-diya', '/products/organic-haldi', '/search?q=diya', '/cart', '/wishlist', '/login', '/track-order', '/faq', '/about', '/contact'];
const shotDir = path.join(__dirname, 'shots', target);
fs.mkdirSync(shotDir, { recursive: true });

async function adminLogin(context) {
  const page = await context.newPage();
  await page.goto(`${base}/admin/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=tel]', process.env.ADMIN_PHONE);
  await page.fill('input[type=password]', process.env.ADMIN_PASSWORD);
  await page.click('button:has-text("Sign In")');
  await page.waitForURL(url => url.pathname === '/admin', { timeout: 20000 });
  await page.close();
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const width of widths) {
    const phone = width < 768;
    const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: width < 1024 });
    await context.addInitScript(() => { try { localStorage.setItem('sac-tour-done', '1'); localStorage.setItem('sac-guest-tour-done', '1'); localStorage.setItem('sac-pin-asked', '1'); } catch {} });
    if (target === 'admin') await adminLogin(context);
    const page = await context.newPage();
    for (const route of pages) {
      try { await page.goto(base + route, { waitUntil: 'networkidle', timeout: 25000 }); } catch { results.push({ width, route, error: 'load timeout' }); continue; }
      await page.waitForTimeout(300);
      const report = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const visible = el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0 && !el.closest('.sr-only'); };
        const label = el => `${el.tagName.toLowerCase()}${el.classList[0] ? '.' + el.classList[0] : ''}${el.textContent?.trim() ? ` "${el.textContent.trim().slice(0, 24)}"` : ''}`;
        const inScroller = el => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
        const out = { overflow: document.documentElement.scrollWidth - vw, offscreen: [], smallTargets: [], clipped: [], unsizedImages: 0, covered: [] };
        const fixed = [...document.querySelectorAll('body *')].filter(el => { const p = getComputedStyle(el).position; return (p === 'fixed' || p === 'sticky') && visible(el); });
        for (const el of document.querySelectorAll('body *')) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.right > vw + 1 && r.left < vw && !inScroller(el)) out.offscreen.push(`${label(el)} right=${Math.round(r.right)}`);
          if (el.matches('a, button, select, input:not([type=hidden]), [role=button]') && !el.closest('p, li.crumb, nav[aria-label=Breadcrumb], .footer-links, footer')) {
            const inlineLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
            if (!inlineLink && (r.width < 40 || r.height < 40) && el.type !== 'checkbox' && el.type !== 'radio') out.smallTargets.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
            // A control whose centre is covered by a fixed/sticky element that is not its ancestor.
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cy > 0 && cy < innerHeight) {
              const top = document.elementFromPoint(cx, cy);
              if (top && !el.contains(top) && !top.contains(el) && fixed.some(f => f.contains(top) && !f.contains(el))) out.covered.push(label(el));
            }
          }
          const s = getComputedStyle(el);
          if (el.children.length === 0 && el.textContent.trim() && (s.overflowX === 'hidden' || s.overflow === 'hidden') && s.textOverflow !== 'ellipsis' && !/\d/.test(s.webkitLineClamp || '') && el.scrollWidth > el.clientWidth + 2) out.clipped.push(label(el));
        }
        for (const img of document.querySelectorAll('img')) if (visible(img) && !img.getAttribute('width') && !img.getAttribute('height') && !/\d/.test(getComputedStyle(img).aspectRatio)) out.unsizedImages++;
        for (const key of ['offscreen', 'smallTargets', 'clipped', 'covered']) out[key] = [...new Set(out[key])].slice(0, 8);
        return out;
      });
      results.push({ width, route, ...report });
      if ([320, 360, 412, 768, 1024, 1440].includes(width)) await page.screenshot({ path: path.join(shotDir, `${width}${route.replace(/[/?=]/g, '_') || '_'}.png`), fullPage: true });
    }
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, `results-${target}.json`), JSON.stringify(results, null, 1));
  const failing = results.filter(r => r.error || r.overflow > 0 || r.offscreen?.length || r.clipped?.length || r.covered?.length || r.unsizedImages);
  for (const r of failing) console.log(`${r.width}px ${r.route}`, r.error ?? '', r.overflow > 0 ? `overflow=${r.overflow}px` : '', JSON.stringify({ off: r.offscreen, clip: r.clipped, covered: r.covered, unsized: r.unsizedImages }));
  const small = {};
  for (const r of results) for (const t of r.smallTargets ?? []) { const key = t.replace(/ \d+×\d+$/, ''); (small[key] ??= new Set()).add(`${r.width}:${t.match(/\d+×\d+$/)[0]}`); }
  console.log(`\nSmall touch targets (<40px) — ${Object.keys(small).length} distinct:`);
  for (const [key, where] of Object.entries(small)) console.log(`  ${key}  ${[...where].slice(0, 4).join(' ')}`);
  console.log(`\n${results.length} page loads, ${failing.length} with layout defects.`);
  process.exitCode = failing.length ? 1 : 0;
})();
