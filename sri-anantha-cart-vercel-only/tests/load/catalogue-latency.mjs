// Catalogue latency benchmark: p50/p95/p99 and throughput per endpoint against a running API.
//   node tests/load/catalogue-latency.mjs <api-origin> [requests-per-endpoint=60] [concurrency=6]
// Results depend on the machine and dataset; compare runs only on the same environment.
const [base = 'http://localhost:4000', n = '60', conc = '6'] = process.argv.slice(2);
const paths = ['/api/v1/home', '/api/v1/categories', '/api/v1/products?limit=12', '/api/v1/products?sort=newest&limit=12',
  '/api/v1/products/brass-diya', '/api/v1/products?q=diya', '/api/v1/search/suggest?q=kum'];
const rows = [];
for (const path of paths) {
  const times = []; let started = 0; let errors = 0;
  await (await fetch(base + path)).arrayBuffer(); // warm-up
  const worker = async () => {
    while (started++ < Number(n)) {
      const t = performance.now();
      const response = await fetch(base + path); await response.arrayBuffer();
      if (!response.ok) errors++;
      times.push(performance.now() - t);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Number(conc) }, worker));
  const total = performance.now() - t0;
  times.sort((a, b) => a - b);
  const q = p => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))]);
  rows.push({ endpoint: path, p50: q(0.5), p95: q(0.95), p99: q(0.99), rps: Number((times.length / total * 1000).toFixed(1)), errors });
}
console.table(rows);
