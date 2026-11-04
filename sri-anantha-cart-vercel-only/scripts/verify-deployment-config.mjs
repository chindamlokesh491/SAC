// Static checks for the Vercel-only deployment contract. Runs in CI.
import fs from 'node:fs';

const root = process.cwd();
const failures = [];
const read = path => fs.readFileSync(`${root}/${path}`, 'utf8').replace(/\r\n?/g, '\n');
const apiPackage = JSON.parse(read('apps/api/package.json'));
const workerPackage = JSON.parse(read('apps/worker/package.json'));
const storefrontPackage = JSON.parse(read('apps/storefront/package.json'));
const adminPackage = JSON.parse(read('apps/admin/package.json'));
const apiEntry = read('apps/api/src/index.ts');
const apiVercel = JSON.parse(read('apps/api/vercel.json'));
const migrationPlan = read('docs/deployment/VERCEL_ONLY_MIGRATION.md');
const apiEnv = read('.env.example');
const storefrontEnv = read('apps/storefront/.env.example');
const adminEnv = read('apps/admin/.env.example');
const mobileEnv = read('apps/mobile/.env.example');

const requireMatch = (pattern, message, source) => { if (!pattern.test(source)) failures.push(message); };

requireMatch(/export default app/, 'Vercel API entrypoint must export the Fastify app as default.', apiEntry);
requireMatch(/runCycle\(/, 'Vercel API entrypoint must invoke the durable job runner.', apiEntry);
requireMatch(/pg_try_advisory_lock/, 'Worker invocation must prevent overlapping cron runs with a PostgreSQL advisory lock.', apiEntry);
requireMatch(/timingSafeEqual/, 'Worker invocation must compare CRON_SECRET in constant time.', apiEntry);
requireMatch(/DATABASE_POOL_SIZE\s*\?\?\s*3/, 'Serverless API must use a small per-instance PostgreSQL pool by default.', apiEntry);
requireMatch(/"regions":\s*\[\s*"bom1"\s*\]/, 'API must be deployed in the Mumbai region (bom1).', JSON.stringify(apiVercel));
requireMatch(/"maxDuration":\s*60/, 'API functions must have a bounded 60-second execution duration.', JSON.stringify(apiVercel));
if (!apiVercel.crons?.some(cron => cron.path === '/api/internal/worker' && cron.schedule === '* * * * *')) {
  failures.push('Vercel API project must schedule the protected worker endpoint every minute (Pro plan required).');
}
if (fs.existsSync(`${root}/render.yaml`)) failures.push('Remove render.yaml: production deployment target is Vercel only.');

for (const [name, pkg] of [['API', apiPackage], ['worker', workerPackage]]) {
  if (!pkg.scripts?.build || !pkg.scripts?.typecheck) failures.push(`${name}: build and typecheck scripts must remain available.`);
}
for (const [name, pkg] of [['storefront', storefrontPackage], ['admin', adminPackage]]) {
  if (pkg.scripts?.build !== 'next build' || !/^next start/.test(pkg.scripts?.start ?? '')) {
    failures.push(`${name}: build/start must use the Next.js production scripts.`);
  }
}
if (!/^DATABASE_URL=/m.test(apiEnv)) failures.push('.env.example must document DATABASE_URL.');
for (const [name, env] of [['storefront', storefrontEnv], ['admin', adminEnv]]) {
  if (!/^API_SERVER_ORIGIN=/m.test(env)) failures.push(`${name} .env.example must document API_SERVER_ORIGIN.`);
}
if (/NEXT_PUBLIC_[A-Z_]*(SECRET|KEY|SALT|TOKEN|PASSWORD|SERVICE_ROLE)/.test(storefrontEnv + adminEnv)) {
  failures.push('Secrets must never be exposed through NEXT_PUBLIC_* variables.');
}
if (/EXPO_PUBLIC_[A-Z_]*(SECRET|SALT|TOKEN|MERCHANT|SERVICE_ROLE)/.test(mobileEnv)) {
  failures.push('Secrets must never be compiled into the mobile app.');
}
if (/SUPABASE_SERVICE_ROLE_KEY/.test(storefrontEnv + adminEnv + mobileEnv)) {
  failures.push('The Supabase service-role key belongs to the API only.');
}
requireMatch(/do not run `app\.listen\(\)`/i, 'Vercel deployment guide must explain that the serverless API exports Fastify without listen().', migrationPlan);

if (failures.length) {
  console.error('Vercel-only deployment contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Vercel-only deployment contract passed: storefront, admin, Fastify API and bounded Cron worker; Supabase PostgreSQL/Storage; Mumbai API region; short serverless DB pool; dashboard-only secrets; Razorpay and checkout remain safely disabled.');
}
