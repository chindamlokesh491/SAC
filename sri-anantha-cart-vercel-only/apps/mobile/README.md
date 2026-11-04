# Sri Anantha Cart — Android app

Expo SDK 53 / React Native app built to the client's mobile designs: home, categories, product list and detail (with variants), cart, three-step checkout (address and delivery slot, payment, review), order success, orders and tracking, profile, saved addresses, wishlist, account settings, and the shopping assistant.

- **Sign-in:** mobile OTP, or Google when client IDs are configured. The session token is kept in Android's encrypted SecureStore and never in plain storage. Optional fingerprint unlock is available from Account Settings.
- **Guest mode:** browsing, search, cart (with − / + quantity) and wishlist work without signing in. They are kept in the app's private storage and move to the account at sign-in. Checkout asks for sign-in and then continues straight to checkout. New users see a short tour and a delivery PIN check; both can be reopened from Profile.
- **Location:** "Use my current location" on the PIN check and the address form asks for foreground location permission only when tapped (background location is blocked in `app.config.ts`). The detected address is filled in and can be edited before saving.
- **Offline:** the last loaded catalogue can be browsed with a "prices may have changed" notice. Cart and checkout always need the server.
- **Links:** `https://<APP_LINK_HOST>/products/…`, `/c/…` and `/account/orders/…` open in the app once the website serves `/.well-known/assetlinks.json` with the Play signing fingerprint (`ANDROID_CERT_SHA256` on the web service). The `sriananthacart://` scheme also works.
- **Payments:** Cash on Delivery. Online payment stays hidden (`EXPO_PUBLIC_ONLINE_PAYMENTS_IN_APP=false`) until the native Razorpay Android SDK is integrated and sandbox-tested.

## Run

```bash
cp .env.example .env    # set EXPO_PUBLIC_API_URL to an API reachable from the phone or emulator
```

```bash
pnpm --filter @sac/mobile android
```

The emulator reaches your computer at `10.0.2.2`; a physical phone needs your computer's LAN IP, and the API must listen on `0.0.0.0`.

## Build for release

`eas.json` defines `preview` (installable APK) and `production` (Play Store bundle) profiles. Before building, confirm the domain in `eas.json` (`sriananthacart.in` is a placeholder until the client confirms theirs).

```bash
npx eas-cli build --platform android --profile production
```

Every `EXPO_PUBLIC_*` value is compiled into the app and is readable by anyone, so only public identifiers belong there. Never put API keys, the Razorpay key secret or session secrets in them.
