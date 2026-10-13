# Release v1.0 — Lang Nuong Vietnam Group Website

The Lang Nuong Vietnam Group homepage has been rebuilt as a self-contained static site serving all assets directly from the GitHub Pages repository. The hero now uses the original cover photo (`hero-cover.jpg`, 206 KB, 1152×1440) as a full-bleed background with the headline, subheading, and contact section sitting on top — no video, no loading delay. The site is fully offline-cached by the browser after the first load, with every image, font, and stylesheet served from the same origin.

All four restaurant brand pages (BBQ, 1980s, Little Hanoi, Exclusive) now carry their own cover photos stored locally in `assets/cover/` instead of pulling from the external `langnuonggroup.com` CDN. This removes a dependency on a third-party host and means the site works even if that CDN changes or goes down. The home page section headings — About Us, Our Brands, and Gallery — carry the same gold underline highlight used on the brand pages, applied through the shared `brand-page` body class and `section-title` style.

The display typeface for all hero subheadings has been switched to Righteous, a self-hosted TTF (`righteous-latin-400-normal.ttf`) loaded via `@font-face` with `font-display: swap`. This gives the subheadings a distinct cursive character while the rest of the site keeps Gilroy for body and headings. The About Us copy, the reservation lines on each brand page, and every gallery caption all render in Righteous now.

## What this release covers

- **Hero restored to image-only** with the correct cover photo (`hero-cover.jpg` at the repo root, 206 KB) — the bad 15 KB blank placeholder at `assets/hero-cover.jpg` was removed.
- **Cover photos for all four brand pages** downloaded from the CDN and committed under `assets/cover/` (`G8.jpg`, `hanoifood1.jpg`, `G6.jpg`) plus the existing BBQ cover at `assets/bbq/bbq-squid.jpg`.
- **Gold underline highlight** added to home page section titles (About Us, Our Brands, Gallery) via `brand-page` + `section-title` classes, matching the brand pages.
- **Righteous font** self-hosted and applied to `.hero-sub` across all pages.
- **All "Make a Reservation" buttons removed** from every page — hero CTAs and about-section buttons.
- **"Best BBQ" underlined** in the home page headline with the same animated underline SVG used on the BBQ page.

## Known limitations

The shop hero subheadings intentionally keep Gilroy/serif and are not affected by the Righteous change — that is by design, since the shop page uses a different visual identity. The cover photos are served from the repo at their original CDN sizes (474–779 KB), which is fine for desktop but may be noticeable on slow mobile connections; they have not been re-compressed for this release. The site still relies on the external SNS/logo images referenced in the brand cards and footer, which remain hosted on `langnuonggroup.com`.
