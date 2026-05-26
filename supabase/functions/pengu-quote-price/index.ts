// Edge function: pengu-quote-price
// Signs an EIP-712 ShopQuote that PenguCrushV2 verifies during shop purchases.
// POST { buyer, skuName, currency } → { quote, signature, ttlSec }
// Server is the source of truth for bundle size + price. Any qty in the
// request body is ignored — clients buy exactly one bundle per click.

import { signShopQuote, sku, randomNonce, getEthUsdPrice, usdMicrosToWei, SKU_BUNDLES, EthUsdUnavailable, type ShopQuote } from './_shared/eip712.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,apikey',
};
const QUOTE_TTL_SEC = 90;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS });
  try {
    const body = await req.json();
    const buyer = (body?.buyer || '').toLowerCase();
    const skuName = body?.skuName;
    const currency = (body?.currency || 'ETH').toUpperCase();
    if (!/^0x[a-f0-9]{40}$/.test(buyer)) return json({ error: 'bad buyer' }, 400);
    const bundle = SKU_BUNDLES[skuName];
    if (!bundle) return json({ error: 'unknown sku' }, 400);
    if (!['ETH', 'USDC'].includes(currency)) return json({ error: 'bad currency' }, 400);

    const qty = bundle.size;
    const totalUsdMicros = bundle.priceMicros;
    let amount: bigint;
    if (currency === 'USDC') {
      amount = totalUsdMicros;
    } else {
      try {
        const ethUsd = await getEthUsdPrice();
        amount = usdMicrosToWei(totalUsdMicros, ethUsd);
      } catch (e) {
        if (e instanceof EthUsdUnavailable) {
          // Fail-closed: don't mint a mis-priced quote. Client should retry.
          return json({ error: 'eth_usd_unavailable', retryAfterSec: 30 }, 503);
        }
        throw e;
      }
    }

    const skuHash = sku(skuName);
    const nonce = randomNonce();
    const deadline = Math.floor(Date.now() / 1000) + QUOTE_TTL_SEC;
    const quote: ShopQuote = {
      buyer: buyer as `0x${string}`, sku: skuHash, qty,
      currency: currency === 'USDC' ? 1 : 0,
      amount: amount.toString(), nonce, deadline,
    };
    const signature = await signShopQuote(quote);
    return json({ quote, signature, ttlSec: QUOTE_TTL_SEC });
  } catch (err) {
    console.error('pengu-quote-price error:', err);
    return json({ error: 'server_error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
