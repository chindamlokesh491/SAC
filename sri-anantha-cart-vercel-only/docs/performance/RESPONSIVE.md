# Responsive audit (Stage 2)

Scripts in `tests/responsive/`. Each loads every page at **320, 360, 375, 390, 412, 430, 768, 1024, 1280 and 1440 px** (touch and mobile emulation below 768 px) and checks:
- horizontal page overflow;
- elements past the right edge (except inside deliberate scroll areas);
- clipped text;
- images without dimensions (layout shift);
- controls covered by fixed elements;
- touch targets under 40 px.

Screenshots were reviewed by eye as well, which found two defects the script could not see. Reports are in `tests/responsive/*-report.txt`. Screenshots (not committed) go to `tests/responsive/shots/`.

## Results

| Surface | Before | After |
| --- | --- | --- |
| Storefront, 13 pages × 10 widths | 13 page loads with overflow (all pages at 320 px: top bar +11 px, listing sort bar +28 px); header on two rows at 320–390 px; prices and stock tags cut off; floating chat button covering Add to Cart; header icons 23–25 px | **0 defects in 130 page loads.** One-row header on every phone width, 44 px touch targets on phones and tablets, chat opens from the top bar or menu below 1400 px, balanced tablet grids |
| Admin, 12 pages × 10 widths | 30 page loads with overflow (dashboard up to +582 px, reports +380 px, delivery +16 px, KPI notes); 30–34 px buttons | **0 defects in 120 page loads.** Tables scroll inside their panels, grids collapse, 44 px controls on touch screens |
| Android app (React Native web build), 7 screens × 5 sizes (320, 360, 412 phones; 768 tablet; 780×360 landscape) | Chat button over content; tab label cut at 320 px; 2-column grid on tablets; 36 px buttons | **0 defects in 35 screens, 0 small targets.** 2–5 column grid, assistant in the header, 44 px buttons, capped product photo in landscape |

## What remains

- **Storefront desktop (1280 px and above, mouse):** top-bar links and header labels are 20–29 px tall by design. One inline "sign in" link in a sentence is 21 px tall.
- **Admin:** the width of chart bars depends on the data. Pointer-only desktop buttons stay 30–34 px.
- **Android:** the web build uses the same React Native layout engine, but it is **not a device test**. Fonts, density buckets, notches, gesture navigation and the system font-size setting must still be checked on an emulator or a real phone (small, standard and large Android, plus a tablet) before release.
