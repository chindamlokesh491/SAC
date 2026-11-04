# Launch checklist

Phase 1 implementation is in final integration and acceptance testing; do not treat this ZIP as production-ready until the open items below are closed. Web online checkout is integrated with the client's existing **Razorpay** account in test mode, but remains disabled pending webhook, refund, and acceptance completion, SMS uses the existing **Airtel DLT** entity through **SMS Gateway Hub**, and **Shiprocket** stays off until the service type is confirmed. Details: `docs/integrations/`. The items below are what the client must supply or decide.

## Needed from the client

### Accounts and credentials (enter in the hosting dashboard, never by email or chat)
- [ ] **Razorpay** (existing account): enable test mode, generate test keys, create the test webhook. See [RAZORPAY.md](../integrations/RAZORPAY.md). Live keys only after test acceptance. Blocks: online payment.
- [ ] **Airtel DLT + SMS Gateway Hub** (existing): PE ID, header, approved template IDs and exact texts, and the API document and key. See [SMS_DLT.md](../integrations/SMS_DLT.md). Blocks: customer sign-in, and therefore launch.
- [ ] **Store email for location lookup** (`GEOCODER_CONTACT`), or a commercial geocoder account if traffic will be high. Without one, customers type their PIN code instead.
- [ ] **Google OAuth** client IDs (web, and Android using the Play signing SHA-1). Optional: the button stays hidden without them.
- [ ] **Hosting:** Vercel Pro for storefront, admin, Fastify API and per-minute Cron worker; Supabase for PostgreSQL and Storage. See [HOSTING.md](HOSTING.md).
- [ ] **Shiprocket:** service type (standard or hyperlocal), pickup location, API user. See [SHIPROCKET.md](../integrations/SHIPROCKET.md).
- [ ] **Domain**: name, registrar and DNS access. See [DOMAIN.md](DOMAIN.md).
- [ ] **Google Play Console** account, plus the app-signing SHA-256 for Android App Links.

### Business details
- [ ] Legal business name, **GSTIN**, registered address and state. These print on every tax invoice.
- [ ] Support phone, email, WhatsApp number and social media links (footer and contact page).
- [ ] Approved text for About, Contact, FAQs, Shipping, Returns & Refunds, Privacy Policy and Terms (current text is a draft).
- [ ] Confirm the **return window** (built as 48 hours after delivery) and whether COD refunds are paid by UPI or bank transfer.
- [ ] **Delivery:** serviceable PIN codes, delivery fee, minimum order, free-delivery threshold (₹499 assumed), express hours and scheduled slots, and COD limit (₹2,000 assumed).

### Catalogue
- [ ] Real products: names, prices, MRP, stock, GST rate and HSN code for each item, and variants (sizes or packs).
- [ ] High-resolution product and category photos. The demo uses images cut from the design files; some category images are low-resolution crops.

## Deliberate differences from the designs
- **Ratings and reviews and coupons** appear in the designs (including the mobile home design) but are Phase 2 in the scope document. They are not shown, rather than shown with fake numbers.
- **Guest cart:** the first brief said no guest cart. The client later asked for guest browsing, so guests now keep a cart and wishlist on their device and sign in at checkout.
- **Admin dashboard** shows the 12 KPIs listed in the scope (the design mock shows 10).
- **Mobile "Standard delivery (1–2 days)"** is replaced by the scope's scheduled delivery slots.

## Go-live steps
1. Deploy following [DEPLOYMENT.md](DEPLOYMENT.md). Create the admin account with `staff:grant` (placeholder number `9000000000`) and give the owner the temporary password privately. They set their own password at first sign-in and change the number to theirs under **My account & password**.
2. Enter store settings, delivery zones and slots, categories and products in `/admin`. Choose up to 8 featured products and 8 featured categories; the home page fills any empty places at random. Add other staff in **Settings → Admin accounts**.
3. Configure the SMS provider and test sign-in on a real phone.
4. Set `CHECKOUT_ENABLED=true`. Place and fulfil one real COD order end to end, and check the invoice.
5. Build the Android app (`eas build --profile production`), test it on a device and submit it to Play internal testing.
6. After Razorpay test-mode acceptance, webhook and refund implementation, and explicit client approval, enable `ONLINE_PAYMENTS_ENABLED=true` for web. Keep Android online payments disabled until its native Razorpay SDK flow passes device testing.
7. Confirm database backups and a test restore, uptime alerts and a `pnpm audit` check.
