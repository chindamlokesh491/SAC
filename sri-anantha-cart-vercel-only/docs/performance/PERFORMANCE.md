# Performance: before and after (Stage 2)

All numbers were measured in the **local development container**, not in production: API, PostgreSQL 16 and browser on the same machine, so there is no network latency between them. The same dataset, machine and scripts were used before and after. Production adds network time between the API, database and users; choosing regions close together matters (see `docs/deployment/HOSTING.md`).

## API latency on the catalogue

Scaled dataset (`database/performance/generate-dataset.sql`): 462 products, 100,000 orders, 300,000 order lines. Run with `node tests/load/catalogue-latency.mjs`.

| Endpoint | Before p50 / p95 (ms) | After p50 / p95 (ms) |
| --- | --- | --- |
| `/api/v1/home` | 11,056 / 14,457 | **36 / 71** |
| `/api/v1/products` (popular) | 8,137 / 8,711 | **18 / 27** |
| `/api/v1/products?sort=newest` | 8,058 / 9,090 | **16 / 25** |
| `/api/v1/products/:slug` | 2,292 / 2,539 | **21 / 32** |
| `/api/v1/products?q=diya` | 3,234 / 3,395 | **41 / 66** |
| `/api/v1/search/suggest` | 399 / 463 | **20 / 30** |
| `/api/v1/categories` | 5 / 8 | 12 / 17 |

"Before" ran 20 requests per endpoint at concurrency 4, because each took seconds; "after" ran 100 at concurrency 10. Raw output is in `database/performance/before-scaled.txt` and `after-scaled.txt`. On the small demo catalogue (24 products) the API was already 10–70 ms (`before-demo.txt`).

**Cause:** every product card added up 90 days of `order_items` for that product, and `order_items` had no index on `product_id` or `order_id`, so each request scanned 300,000 rows once per product. With `EXPLAIN (ANALYZE, BUFFERS)` the listing query took 8,571 ms; an index alone brought it to 2,249 ms; the maintained summary (migration 022) brought it to 3.4 ms.

**Other changes:**
- The home page's random fill no longer uses `ORDER BY random()`. It shuffles the top 48 in memory.
- Listings accept keyset pagination (`pagination.next_cursor`).
- Missing foreign-key indexes were added only on paths that are queried or that cascading deletes use.

## Storefront caching

- The home and category pages render per request but read the catalogue from Next.js's data cache, tagged `catalog`. Five consecutive page views made **0** API calls after the first.
- An admin change records `catalog.changed`, and the worker calls `/internal/revalidate`. Measured end to end: a renamed category appeared on the storefront **0.9 s** after the admin save, instead of up to 60 s.
- Customer, cart, checkout, payment, order and admin data are never cached. Those requests carry the session cookie and are fetched with no-store.

## Mobile front-end (LCP)

Measured with `tests/load/mobile-lcp.cjs`: 390×844 at 3× density, throttled to 150 ms round trip, 1.6 Mbps and 4× CPU slowdown, median of 3 runs.

| Page | LCP before | LCP after | CLS after |
| --- | --- | --- | --- |
| Home | 2,852 ms | **1,656 ms** | 0.023 |
| Category | 2,604 ms | **2,384 ms** | 0 |
| Product | 3,148 ms | **2,628 ms** | 0 |
| Cart | 840 ms | **712 ms** | 0.028 |

- The hero image is now an `<img>` with `fetchpriority=high` and a preload; before, it was a CSS background found late.
- Product photos have 400, 720 and 1200 px versions with `srcset`.
- Fonts are self-hosted: the ₹ sign comes from a 1 KB subset instead of two "latin-ext" files of 85 KB and 42 KB.
- The admin's CSS no longer loads on the storefront.
- The product page remains slightly above the 2.5 s target in this strict emulation, because at 3× density the browser correctly chooses the 1200 px photo. Real devices at 2–2.75× density get the 720 px file.

## Not yet measured

Production latency (Vercel Mumbai `bom1` ↔ Supabase Mumbai), load at real traffic, pool saturation under load, and Core Web Vitals from real users. These come after deployment.
