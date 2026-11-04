/**
 * Android App Links verification. Set ANDROID_CERT_SHA256 to the Play App Signing
 * certificate fingerprint(s), comma separated, so product links open in the app.
 */
export const dynamic = 'force-static';

export function GET() {
  const fingerprints = (process.env.ANDROID_CERT_SHA256 ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const body = fingerprints.length
    ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'in.sriananthacart.app', sha256_cert_fingerprints: fingerprints } }]
    : [];
  return Response.json(body, { headers: { 'cache-control': 'public, max-age=3600' } });
}
