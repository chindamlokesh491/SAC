// Admin list latency benchmark (p50/p95/p99, throughput) against a running API with a large order history.
//   node tests/load/admin-latency.mjs <api-origin> <staff-phone> <password> [requests=60] [concurrency=4]
// Use a disposable benchmark database (database/performance/generate-dataset.sql). The account must have a
// permanent password (not a temporary one). Results depend on the machine; compare runs on the same environment.
const [base = 'http://localhost:4000', phone, password, n = '60', conc = '4'] = process.argv.slice(2);
if (!phone || !password) { console.error('Usage: node tests/load/admin-latency.mjs <api-origin> <staff-phone> <password> [requests] [concurrency]'); process.exit(1); }
const login = await (await fetch(`${base}/api/v1/auth/staff/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) })).json();
const token = login.data?.accessToken;
if (!token || login.data.user.must_change_password) { console.error('Sign-in failed or the password is temporary.'); process.exit(1); }
const headers = { authorization: `Bearer ${token}` };
const paths = ['/api/v1/admin/orders?limit=20', '/api/v1/admin/orders?limit=20&offset=5000', '/api/v1/admin/orders?status=delivered&limit=20',
  '/api/v1/admin/orders?search=SA10001&limit=20', '/api/v1/admin/customers?limit=20', '/api/v1/admin/dashboard', '/api/v1/admin/reports/summary'];
const rows = [];
for (const path of paths) {
  const times = []; let started = 0; let errors = 0;
  await (await fetch(base + path, { headers })).arrayBuffer();
  const worker = async () => {
    while (started++ < Number(n)) {
      const t = performance.now();
      const response = await fetch(base + path, { headers }); await response.arrayBuffer();
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
