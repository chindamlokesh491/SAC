# Storefront (`@sac/storefront`)

The customer website (Next.js App Router). It server-renders the catalogue, supports a guest cart and wishlist, OTP or Google sign-in, three-step checkout, orders, tracking, invoices and the account pages. `/api` and `/media` are proxied to the API (`API_SERVER_ORIGIN`), so session cookies stay first-party and the browser never calls the API on another origin.

```bash
pnpm --filter @sac/storefront dev     # http://localhost:3000
```

- **Catalogue data:** cached with the `catalog` tag for 60 s. Admin changes refresh it at once through the worker (`/internal/revalidate`, protected by `REVALIDATE_TOKEN`).
- **No secrets in the browser:** only `NEXT_PUBLIC_*` values are public. `INTERNAL_API_TOKEN` and `REVALIDATE_TOKEN` are server-side only. See `.env.example`.
- **Shared code:** `@sac/ui-web` (components, tokens, fonts), `@sac/api-client`, `@sac/contracts`, `@sac/shared`, and `@sac/config` (security headers).
- **Responsive:** checked at 320–1440 px with `node tests/responsive/audit.cjs storefront` (see `docs/performance/RESPONSIVE.md`).
