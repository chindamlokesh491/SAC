# Stage 2 file changes (main 30af58d → feat/stage2-platform)

Generated with `git diff --name-status -M 30af58d HEAD`. R = moved (old → new), A = created, M = modified, D = deleted.

```
M  .env.example
M  .github/workflows/ci.yml
M  .gitignore
M  README.md
A  apps/admin/.env.example
A  apps/admin/README.md
R100  apps/web/app/admin/account/page.tsx  apps/admin/app/admin/account/page.tsx
R097  apps/web/app/admin/categories/page.tsx  apps/admin/app/admin/categories/page.tsx
R097  apps/web/app/admin/customers/[id]/page.tsx  apps/admin/app/admin/customers/[id]/page.tsx
R100  apps/web/app/admin/customers/page.tsx  apps/admin/app/admin/customers/page.tsx
R098  apps/web/app/admin/delivery/page.tsx  apps/admin/app/admin/delivery/page.tsx
R098  apps/web/app/admin/inventory/page.tsx  apps/admin/app/admin/inventory/page.tsx
R093  apps/web/app/admin/layout.tsx  apps/admin/app/admin/layout.tsx
R098  apps/web/app/admin/login/page.tsx  apps/admin/app/admin/login/page.tsx
R089  apps/web/app/admin/orders/[id]/invoice/page.tsx  apps/admin/app/admin/orders/[id]/invoice/page.tsx
R097  apps/web/app/admin/orders/[id]/page.tsx  apps/admin/app/admin/orders/[id]/page.tsx
R097  apps/web/app/admin/orders/page.tsx  apps/admin/app/admin/orders/page.tsx
R098  apps/web/app/admin/page.tsx  apps/admin/app/admin/page.tsx
R097  apps/web/app/admin/payments/page.tsx  apps/admin/app/admin/payments/page.tsx
R100  apps/web/app/admin/products/[id]/page.tsx  apps/admin/app/admin/products/[id]/page.tsx
R100  apps/web/app/admin/products/new/page.tsx  apps/admin/app/admin/products/new/page.tsx
R099  apps/web/app/admin/products/page.tsx  apps/admin/app/admin/products/page.tsx
R096  apps/web/app/admin/reports/page.tsx  apps/admin/app/admin/reports/page.tsx
R094  apps/web/app/admin/search/page.tsx  apps/admin/app/admin/search/page.tsx
R099  apps/web/app/admin/settings/page.tsx  apps/admin/app/admin/settings/page.tsx
A  apps/admin/app/layout.tsx
A  apps/admin/app/robots.ts
R100  apps/web/components/admin/AdminFrame.tsx  apps/admin/components/admin/AdminFrame.tsx
R098  apps/web/components/admin/AdminProvider.tsx  apps/admin/components/admin/AdminProvider.tsx
R095  apps/web/components/admin/AdminShell.tsx  apps/admin/components/admin/AdminShell.tsx
R100  apps/web/components/admin/Charts.tsx  apps/admin/components/admin/Charts.tsx
R096  apps/web/components/admin/ConfirmDialog.tsx  apps/admin/components/admin/ConfirmDialog.tsx
R085  apps/web/components/admin/ImageUpload.tsx  apps/admin/components/admin/ImageUpload.tsx
R098  apps/web/components/admin/PasswordForms.tsx  apps/admin/components/admin/PasswordForms.tsx
R098  apps/web/components/admin/ProductForm.tsx  apps/admin/components/admin/ProductForm.tsx
R098  apps/web/components/admin/StaffManager.tsx  apps/admin/components/admin/StaffManager.tsx
R095  apps/web/components/admin/ui.tsx  apps/admin/components/admin/ui.tsx
R080  apps/web/lib/api.ts  apps/admin/lib/api.ts
R100  apps/web/next-env.d.ts  apps/admin/next-env.d.ts
A  apps/admin/next.config.ts
A  apps/admin/package.json
R100  apps/web/public/brand/logo-full.webp  apps/admin/public/brand/logo-full.webp
R100  apps/web/public/brand/lotus.png  apps/admin/public/brand/lotus.png
R100  apps/web/public/icons/apple-touch-icon.png  apps/admin/public/icons/apple-touch-icon.png
R100  apps/web/public/icons/favicon-32.png  apps/admin/public/icons/favicon-32.png
R100  apps/web/public/icons/favicon-64.png  apps/admin/public/icons/favicon-64.png
R087  apps/web/styles/admin.css  apps/admin/styles/admin.css
A  apps/admin/tsconfig.json
M  apps/api/package.json
A  apps/api/scripts/backfill-media-variants.mjs
M  apps/api/scripts/grant-role.mjs
A  apps/api/scripts/lib/db-ssl.d.mts
A  apps/api/scripts/lib/db-ssl.mjs
A  apps/api/scripts/migrate-media-to-supabase.mjs
M  apps/api/scripts/migrate.mjs
M  apps/api/scripts/seed-demo.mjs
M  apps/api/src/app.ts
A  apps/api/src/catalog/cursor.ts
M  apps/api/src/catalog/queries.ts
M  apps/api/src/config.ts
A  apps/api/src/jobs/index.ts
D  apps/api/src/jobs/non-overlapping-task.ts
A  apps/api/src/jobs/queue.ts
A  apps/api/src/jobs/runner.ts
A  apps/api/src/jobs/tasks.ts
M  apps/api/src/media/cleanup.ts
M  apps/api/src/media/media.ts
A  apps/api/src/media/store.ts
M  apps/api/src/readiness.ts
M  apps/api/src/routes/admin/categories.ts
M  apps/api/src/routes/admin/index.ts
M  apps/api/src/routes/admin/products.ts
M  apps/api/src/routes/catalog.ts
M  apps/api/src/server.ts
A  apps/api/test/catalogue-performance.integration.test.ts
A  apps/api/test/jobs.integration.test.ts
A  apps/api/test/media-storage.integration.test.ts
D  apps/api/test/non-overlapping-task.test.ts
M  apps/api/test/support/harness.ts
M  apps/api/tsconfig.json
M  apps/mobile/App.tsx
M  apps/mobile/package.json
M  apps/mobile/src/api.ts
M  apps/mobile/src/components/ui.tsx
M  apps/mobile/src/guest.ts
M  apps/mobile/src/location.ts
M  apps/mobile/src/navigation-types.ts
M  apps/mobile/src/screens/AccountScreens.tsx
M  apps/mobile/src/screens/AssistantScreen.tsx
M  apps/mobile/src/screens/CartScreen.tsx
M  apps/mobile/src/screens/CategoriesScreen.tsx
M  apps/mobile/src/screens/CheckoutScreens.tsx
M  apps/mobile/src/screens/HomeScreen.tsx
M  apps/mobile/src/screens/OrderScreens.tsx
M  apps/mobile/src/screens/ProductListScreen.tsx
M  apps/mobile/src/screens/ProductScreen.tsx
M  apps/mobile/src/screens/WelcomeScreen.tsx
M  apps/mobile/src/session.tsx
M  apps/mobile/src/theme.ts
R061  apps/web/.env.example  apps/storefront/.env.example
A  apps/storefront/README.md
R100  apps/web/app/(store)/[page]/page.tsx  apps/storefront/app/(store)/[page]/page.tsx
R096  apps/web/app/(store)/account/addresses/page.tsx  apps/storefront/app/(store)/account/addresses/page.tsx
R100  apps/web/app/(store)/account/layout.tsx  apps/storefront/app/(store)/account/layout.tsx
R087  apps/web/app/(store)/account/orders/[id]/invoice/page.tsx  apps/storefront/app/(store)/account/orders/[id]/invoice/page.tsx
R097  apps/web/app/(store)/account/orders/[id]/page.tsx  apps/storefront/app/(store)/account/orders/[id]/page.tsx
R094  apps/web/app/(store)/account/orders/page.tsx  apps/storefront/app/(store)/account/orders/page.tsx
R100  apps/web/app/(store)/account/page.tsx  apps/storefront/app/(store)/account/page.tsx
R097  apps/web/app/(store)/account/settings/page.tsx  apps/storefront/app/(store)/account/settings/page.tsx
R100  apps/web/app/(store)/account/wishlist/page.tsx  apps/storefront/app/(store)/account/wishlist/page.tsx
R100  apps/web/app/(store)/c/[slug]/page.tsx  apps/storefront/app/(store)/c/[slug]/page.tsx
R097  apps/web/app/(store)/cart/page.tsx  apps/storefront/app/(store)/cart/page.tsx
R089  apps/web/app/(store)/categories/page.tsx  apps/storefront/app/(store)/categories/page.tsx
R098  apps/web/app/(store)/checkout/page.tsx  apps/storefront/app/(store)/checkout/page.tsx
R097  apps/web/app/(store)/checkout/payment-status/page.tsx  apps/storefront/app/(store)/checkout/payment-status/page.tsx
R100  apps/web/app/(store)/layout.tsx  apps/storefront/app/(store)/layout.tsx
R099  apps/web/app/(store)/login/LoginForm.tsx  apps/storefront/app/(store)/login/LoginForm.tsx
R100  apps/web/app/(store)/login/page.tsx  apps/storefront/app/(store)/login/page.tsx
R100  apps/web/app/(store)/not-found.tsx  apps/storefront/app/(store)/not-found.tsx
R095  apps/web/app/(store)/orders/[id]/confirmation/page.tsx  apps/storefront/app/(store)/orders/[id]/confirmation/page.tsx
R080  apps/web/app/(store)/page.tsx  apps/storefront/app/(store)/page.tsx
R085  apps/web/app/(store)/products/[slug]/page.tsx  apps/storefront/app/(store)/products/[slug]/page.tsx
R100  apps/web/app/(store)/search/page.tsx  apps/storefront/app/(store)/search/page.tsx
R097  apps/web/app/(store)/track-order/page.tsx  apps/storefront/app/(store)/track-order/page.tsx
R100  apps/web/app/(store)/wishlist/page.tsx  apps/storefront/app/(store)/wishlist/page.tsx
R100  apps/web/app/.well-known/assetlinks.json/route.ts  apps/storefront/app/.well-known/assetlinks.json/route.ts
A  apps/storefront/app/internal/revalidate/route.ts
R074  apps/web/app/layout.tsx  apps/storefront/app/layout.tsx
R100  apps/web/app/manifest.ts  apps/storefront/app/manifest.ts
R063  apps/web/app/robots.ts  apps/storefront/app/robots.ts
R100  apps/web/app/sitemap.ts  apps/storefront/app/sitemap.ts
R096  apps/web/components/store/AddressModal.tsx  apps/storefront/components/store/AddressModal.tsx
R100  apps/web/components/store/Breadcrumbs.tsx  apps/storefront/components/store/Breadcrumbs.tsx
R099  apps/web/components/store/FirstVisit.tsx  apps/storefront/components/store/FirstVisit.tsx
R098  apps/web/components/store/Footer.tsx  apps/storefront/components/store/Footer.tsx
R100  apps/web/components/store/GoogleButton.tsx  apps/storefront/components/store/GoogleButton.tsx
R095  apps/web/components/store/Header.tsx  apps/storefront/components/store/Header.tsx
R099  apps/web/components/store/Listing.tsx  apps/storefront/components/store/Listing.tsx
R100  apps/web/components/store/ListingControls.tsx  apps/storefront/components/store/ListingControls.tsx
R097  apps/web/components/store/LocationTools.tsx  apps/storefront/components/store/LocationTools.tsx
R091  apps/web/components/store/MobileMenu.tsx  apps/storefront/components/store/MobileMenu.tsx
R100  apps/web/components/store/NewsletterForm.tsx  apps/storefront/components/store/NewsletterForm.tsx
R096  apps/web/components/store/OrderSummary.tsx  apps/storefront/components/store/OrderSummary.tsx
R095  apps/web/components/store/ProductCard.tsx  apps/storefront/components/store/ProductCard.tsx
R096  apps/web/components/store/ProductPurchase.tsx  apps/storefront/components/store/ProductPurchase.tsx
R100  apps/web/components/store/ServiceWorker.tsx  apps/storefront/components/store/ServiceWorker.tsx
R093  apps/web/components/store/ShoppingAssistant.tsx  apps/storefront/components/store/ShoppingAssistant.tsx
R082  apps/web/components/store/StatusBadge.tsx  apps/storefront/components/store/StatusBadge.tsx
R098  apps/web/components/store/StoreProvider.tsx  apps/storefront/components/store/StoreProvider.tsx
R091  apps/web/components/store/Tracker.tsx  apps/storefront/components/store/Tracker.tsx
R096  apps/web/components/store/WishlistView.tsx  apps/storefront/components/store/WishlistView.tsx
A  apps/storefront/lib/api.ts
R099  apps/web/lib/cms.ts  apps/storefront/lib/cms.ts
A  apps/storefront/lib/images.ts
R100  apps/web/lib/listing.ts  apps/storefront/lib/listing.ts
R084  apps/web/lib/server-api.ts  apps/storefront/lib/server-api.ts
A  apps/storefront/next-env.d.ts
A  apps/storefront/next.config.ts
R067  apps/web/package.json  apps/storefront/package.json
R100  apps/web/public/brand/logo-full.png  apps/storefront/public/brand/logo-full.png
A  apps/storefront/public/brand/logo-full.webp
A  apps/storefront/public/brand/lotus.png
A  apps/storefront/public/icons/apple-touch-icon.png
A  apps/storefront/public/icons/favicon-32.png
A  apps/storefront/public/icons/favicon-64.png
R100  apps/web/public/icons/icon-192.png  apps/storefront/public/icons/icon-192.png
R100  apps/web/public/icons/icon-512.png  apps/storefront/public/icons/icon-512.png
R100  apps/web/public/icons/maskable-512.png  apps/storefront/public/icons/maskable-512.png
R100  apps/web/public/images/hero-temple.webp  apps/storefront/public/images/hero-temple.webp
R100  apps/web/public/images/temple-sidebar.webp  apps/storefront/public/images/temple-sidebar.webp
R100  apps/web/public/offline.html  apps/storefront/public/offline.html
R100  apps/web/public/sw.js  apps/storefront/public/sw.js
R092  apps/web/styles/store.css  apps/storefront/styles/store.css
A  apps/storefront/tsconfig.json
D  apps/web/README.md
D  apps/web/next.config.ts
A  apps/worker/package.json
A  apps/worker/src/main.ts
A  apps/worker/tsconfig.json
M  database/migrations/021_database_hardening.sql
A  database/migrations/022_catalogue_performance.sql
A  database/migrations/023_jobs_outbox_integrations.sql
A  database/migrations/024_access_control.sql
A  database/migrations/025_media_storage.sql
M  database/migrations/README.md
A  database/performance/after-scaled.txt
A  database/performance/before-demo.txt
A  database/performance/before-scaled.txt
A  database/performance/generate-dataset.sql
A  database/performance/lcp-after.txt
A  database/performance/lcp-before.txt
M  database/roles/app_runtime_role.sql
D  docs/ARCHITECTURE.md
D  docs/DEPLOYMENT.md
R100  docs/ADMIN_API.md  docs/api/ADMIN_API.md
A  docs/architecture/ARCHITECTURE.md
R080  docs/SECURITY.md  docs/architecture/SECURITY.md
A  docs/database/DATABASE.md
A  docs/deployment/DEPLOYMENT.md
A  docs/deployment/DOMAIN.md
A  docs/deployment/HOSTING.md
R072  docs/LAUNCH_CHECKLIST.md  docs/deployment/LAUNCH_CHECKLIST.md
A  docs/integrations/RAZORPAY.md
A  docs/integrations/SHIPROCKET.md
A  docs/integrations/SMS_DLT.md
R100  docs/PAYU_SANDBOX_ACCEPTANCE.md  docs/payments/RAZORPAY_TEST_ACCEPTANCE.md
A  docs/performance/PERFORMANCE.md
A  docs/performance/RESPONSIVE.md
M  package.json
A  packages/api-client/package.json
R099  packages/shared/src/api.ts  packages/api-client/src/index.ts
A  packages/api-client/tsconfig.json
A  packages/config/next-security.d.mts
A  packages/config/next-security.mjs
A  packages/config/package.json
R100  tsconfig.base.json  packages/config/tsconfig/base.json
R067  apps/web/tsconfig.json  packages/config/tsconfig/nextjs.json
A  packages/contracts/package.json
R100  packages/shared/src/types.ts  packages/contracts/src/index.ts
A  packages/contracts/tsconfig.json
M  packages/shared/package.json
M  packages/shared/src/format.ts
M  packages/shared/src/index.ts
R100  apps/web/lib/safe-next.ts  packages/shared/src/navigation.ts
M  packages/shared/tsconfig.json
A  packages/ui-web/fonts/README.md
A  packages/ui-web/fonts/inter-latin.woff2
A  packages/ui-web/fonts/inter-rupee.woff2
A  packages/ui-web/fonts/source-serif-4-latin.woff2
A  packages/ui-web/fonts/source-serif-4-rupee.woff2
A  packages/ui-web/package.json
R096  apps/web/components/store/InvoiceView.tsx  packages/ui-web/src/InvoiceView.tsx
R100  apps/web/components/store/Modal.tsx  packages/ui-web/src/Modal.tsx
A  packages/ui-web/src/index.ts
A  packages/ui-web/styles/fonts.css
A  packages/ui-web/styles/shared.css
R100  apps/web/styles/tokens.css  packages/ui-web/styles/tokens.css
A  packages/ui-web/tsconfig.json
M  pnpm-lock.yaml
M  render.yaml
M  scripts/verify-deployment-config.mjs
M  scripts/verify-migrations.mjs
R094  e2e/storefront-admin.e2e.cjs  tests/e2e/storefront-admin.e2e.cjs
A  tests/load/catalogue-latency.mjs
A  tests/load/mobile-lcp.cjs
A  tests/responsive/admin-report.txt
A  tests/responsive/android-web-audit.cjs
A  tests/responsive/android-web-report.txt
A  tests/responsive/audit.cjs
A  tests/responsive/results-admin.json
A  tests/responsive/results-android-web.json
A  tests/responsive/results-storefront.json
A  tests/responsive/storefront-report.txt
A  tests/security/db-permissions-result.txt
A  tests/security/db-permissions.mjs
A  tests/security/run-supabase-emulation.sh
A  tests/security/supabase-emulation-setup.sql
A  turbo.json
```
