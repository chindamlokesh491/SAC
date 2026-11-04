# Admin panel (`@sac/admin`)

The staff panel (Next.js): dashboard, orders, products, categories, customers, inventory, payments, delivery, reports, settings and admin accounts. It is a separate app and deployment from the storefront (for example on `admin.<domain>`), with a stricter Content-Security-Policy, no third-party scripts and `noindex`. Routes stay under `/admin`.

```bash
pnpm --filter @sac/admin dev     # http://localhost:3001/admin
```

Staff sign in with mobile number and password; the first admin comes from `pnpm --filter @sac/api staff:grant`. Every permission is enforced by the API; the UI only hides what the API would refuse.
