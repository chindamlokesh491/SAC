// Mobile LCP/CLS under throttled 4G (150 ms RTT, 1.6 Mbps down, 4x CPU slowdown), 390x844 @3x, median of 3 runs.
//   node tests/load/mobile-lcp.cjs   (storefront on http://localhost:3000)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const path of ['/', '/c/pooja-essentials', '/products/brass-diya', '/cart']) {
    const vals = [];
    for (let run = 0; run < 3; run++) {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true });
      await ctx.addInitScript(() => { localStorage.setItem('sac-tour-done', '1'); localStorage.setItem('sac-pin-asked', '1'); });
      const p = await ctx.newPage();
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8 * 1024 / 1000 * 1000 / 1024, uploadThroughput: 750e3 / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      let apiCalls = 0, bytes = 0;
      p.on('request', r => { if (r.url().includes('/api/')) apiCalls++; });
      p.on('response', async r => { const l = Number(r.headers()['content-length'] || 0); bytes += l; });
      await p.goto('http://localhost:3000' + path, { waitUntil: 'load', timeout: 60000 });
      await p.waitForTimeout(2500);
      const m = await p.evaluate(() => new Promise(res => {
        let lcp = 0, cls = 0;
        new PerformanceObserver(l => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
        const nav = performance.getEntriesByType('navigation')[0];
        setTimeout(() => res({ lcp: Math.round(lcp), cls: +cls.toFixed(3), ttfb: Math.round(nav.responseStart), transferKB: Math.round(performance.getEntriesByType('resource').reduce((a, r) => a + r.transferSize, nav.transferSize) / 1024) }), 300);
      }));
      vals.push({ ...m, apiCalls });
      await ctx.close();
    }
    vals.sort((a, c) => a.lcp - c.lcp);
    console.log(path.padEnd(22), JSON.stringify(vals[1]));
  }
  await b.close();
})();
