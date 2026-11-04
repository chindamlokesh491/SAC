# Domain: information needed and planned records

The purchased domain and registrar are **not yet confirmed**. Nothing has been guessed or changed. Some code defaults mention `sriananthacart.in` as a placeholder; they are replaced by environment variables at deployment.

## Please confirm

1. The exact domain name (for example `example.in`) and whether it is already registered and paid.
2. The registrar (GoDaddy, Hostinger, BigRock, Namecheap, Google/Squarespace, Cloudflare, …).
3. Who controls DNS: the registrar's DNS, Cloudflare, or another provider. Can you sign in and add records?
4. Existing records to keep: email (MX, SPF, DKIM, DMARC), any current website, verification TXT records.
5. The email address that should own SSL and notification emails.

## Planned hostnames (nothing created yet)

| Hostname | Points to | Record type (typical) |
| --- | --- | --- |
| `<domain>` and `www.<domain>` | Storefront (Vercel) | Vercel: `A 76.76.21.21` for the apex and `CNAME cname.vercel-dns.com` for www. Use the values the hosting dashboard shows. |
| `admin.<domain>` | Admin app | CNAME given by the hosting dashboard |
| `api.<domain>` | API (Vercel) | CNAME given by the Vercel dashboard |
| (optional) `images.<domain>` | Supabase Storage via a custom domain | Supabase custom domains are a paid add-on. Not needed. |

HTTPS certificates are issued automatically by Vercel once the records resolve.

## Settings that depend on the domain

| Setting | Value |
| --- | --- |
| API `PUBLIC_WEB_URL` | `https://<domain>` |
| API `PUBLIC_API_URL` | `https://api.<domain>` |
| Storefront `NEXT_PUBLIC_SITE_URL` | `https://<domain>` |
| Storefront `ADMIN_APP_URL` | `https://admin.<domain>` (sends `/admin` on the shop domain there) |
| Admin `NEXT_PUBLIC_STOREFRONT_URL` | `https://<domain>` |
| API `STOREFRONT_REVALIDATE_URL` | `https://<domain>/internal/revalidate` |
| Android `EXPO_PUBLIC_API_URL`, `APP_LINK_HOST` | `https://api.<domain>`, `<domain>` |
| Razorpay webhook | `https://api.<domain>/api/v1/webhooks/razorpay` |
| Shiprocket webhook | `https://api.<domain>/api/v1/delivery/shiprocket/webhook` |
| Google OAuth origins | `https://<domain>` |
| Android App Links | `https://<domain>/.well-known/assetlinks.json` (served by the storefront) |

DNS records are added only after you approve, by you or with you, in your DNS dashboard.
