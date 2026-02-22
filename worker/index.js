/**
 * Cloudflare Worker — iOS UDID Enrollment Endpoint
 *
 * Flow:
 *   1. iOS downloads the mobileconfig (Profile Service type) from GitHub Pages.
 *   2. User installs the profile; iOS POSTs a CMS/PKCS7-signed plist to this worker.
 *   3. The worker extracts the UDID (and optional device attributes) from the plist.
 *   4. The worker redirects the iOS browser to the result page on GitHub Pages,
 *      passing the UDID as a query parameter.
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler deploy
 *
 * Environment variables (set in wrangler.toml or Cloudflare dashboard):
 *   RESULT_URL — full URL of result.html on GitHub Pages
 *                default: https://gru2007.github.io/clip-cards-link/udid/result.html
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Allow CORS preflight (not strictly needed for iOS, but harmless)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // ── POST /enroll  — iOS sends signed plist here ──
    if (request.method === 'POST' && url.pathname === '/enroll') {
      return handleEnroll(request, env);
    }

    // ── GET /  — health check / human visitor ──
    if (request.method === 'GET') {
      const resultUrl =
        env.RESULT_URL ||
        'https://gru2007.github.io/clip-cards-link/udid/result.html';
      return new Response(
        `UDID enrollment endpoint is running.\nResult page: ${resultUrl}`,
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Core handler
// ────────────────────────────────────────────────────────────────────────────

async function handleEnroll(request, env) {
  try {
    const body = await request.arrayBuffer();

    if (body.byteLength === 0) {
      return errorResponse(400, 'Empty request body');
    }

    // iOS sends the device info as a CMS/PKCS7 SignedData envelope.
    // The payload inside the envelope is a plain-text plist XML, so we can
    // extract it with a regex without needing to fully parse the DER binary.
    //
    // Using iso-8859-1 (binary-safe) to decode so no bytes are dropped.
    const raw = new TextDecoder('iso-8859-1').decode(body);

    // Some older iOS versions send a raw (unsigned) plist directly.
    // Try to find the plist XML in whatever we received.
    const plistXml = extractPlist(raw);

    if (!plistXml) {
      return errorResponse(400, 'Could not locate plist XML in the request body.');
    }

    // ── Extract values from plist ──
    const getValue = (key) => {
      // Matches: <key>KEY</key> ... <string>VALUE</string>
      const re = new RegExp(
        `<key>${escapeRegex(key)}<\\/key>\\s*<string>([^<]+)<\\/string>`,
        'i',
      );
      const m = plistXml.match(re);
      return m ? m[1].trim() : null;
    };

    const udid = getValue('UDID');
    if (!udid) {
      return errorResponse(400, 'UDID key not found in plist.');
    }

    // ── Build redirect URL ──
    const resultBase =
      env.RESULT_URL ||
      'https://gru2007.github.io/clip-cards-link/udid/result.html';

    const params = new URLSearchParams({ udid });

    // Optional extra attributes
    ['PRODUCT', 'VERSION', 'SERIAL', 'IMEI', 'ICCID'].forEach((key) => {
      const val = getValue(key);
      if (val) params.set(key.toLowerCase(), val);
    });

    const redirectTarget = `${resultBase}?${params.toString()}`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectTarget,
        ...corsHeaders(),
      },
    });
  } catch (err) {
    console.error('handleEnroll error:', err);
    return errorResponse(500, `Internal error: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Find the first occurrence of a plist XML document in a (possibly binary) string.
 * The plist is always present as plain text inside the PKCS7 envelope.
 */
function extractPlist(raw) {
  // Full plist document
  const m = raw.match(/<\?xml[\s\S]*?<\/plist>/);
  if (m) return m[0];

  // Fallback: bare <dict> without XML declaration (some iOS versions)
  const d = raw.match(/<plist[\s\S]*?<\/plist>/);
  if (d) return d[0];

  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function errorResponse(status, message) {
  console.error(`[${status}] ${message}`);
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() },
  });
}
