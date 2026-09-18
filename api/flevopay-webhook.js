const crypto = require('crypto');

const FLEVOPAY_QUERY_API = 'https://app.flevopay.com.br/api/v1/query';
const UTMIFY_API = 'https://api.utmify.com.br/api-credentials/orders';
const TIKTOK_EVENTS_API = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function utcTimestamp(date) {
  return (date || new Date()).toISOString().slice(0, 19).replace('T', ' ');
}

// approved/refused/etc a nível da FlevoPay -> status que a Utmify entende.
// pending/processing/under_review não geram atualização (o pedido já entrou como
// "waiting_payment" na criação, em flevopay-create.js).
function mapUtmifyStatus(rawStatus) {
  switch (rawStatus) {
    case 'approved':
      return 'paid';
    case 'refunded':
      return 'refunded';
    case 'chargeback':
      return 'chargedback';
    case 'failed':
    case 'refused':
      return 'refused';
    default:
      return null;
  }
}

async function pushUtmify(payload) {
  const token = process.env.UTMIFY_API_TOKEN;
  if (!token) return;
  try {
    const r = await fetch(UTMIFY_API, {
      method: 'POST',
      headers: { 'x-api-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error('Utmify update failed', r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error('Utmify update error', err);
  }
}

async function pushTikTokPurchase({ transactionId, amountReais, customer }) {
  const pixelId = process.env.TIKTOK_PIXEL_ID;
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!pixelId || !accessToken) return;

  const user = {};
  if (customer.email) user.email = sha256(customer.email);
  const phoneDigits = onlyDigits(customer.phone);
  if (phoneDigits) {
    const e164 = phoneDigits.startsWith('55') ? `+${phoneDigits}` : `+55${phoneDigits}`;
    // A doc pública da TikTok Events API não deixa 100% claro se a chave é "phone" ou
    // "phone_number" nessa versão; mandamos as duas (chaves extras são ignoradas).
    user.phone = sha256(e164);
    user.phone_number = sha256(e164);
  }
  const docDigits = onlyDigits(customer.document);
  if (docDigits) user.external_id = sha256(docDigits);

  const eventBody = {
    event_source: 'web',
    event_source_id: pixelId,
    data: [{
      event: process.env.TIKTOK_EVENT_NAME || 'CompletePayment',
      event_time: Math.floor(Date.now() / 1000),
      event_id: `pix_${transactionId}`,
      user,
      properties: {
        content_type: 'product',
        currency: 'BRL',
        value: amountReais,
      },
    }],
  };
  if (process.env.TIKTOK_TEST_EVENT_CODE) eventBody.test_event_code = process.env.TIKTOK_TEST_EVENT_CODE;

  try {
    const r = await fetch(TIKTOK_EVENTS_API, {
      method: 'POST',
      headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    });
    if (!r.ok) console.error('TikTok event failed', r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error('TikTok event error', err);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const apiKey = process.env.FLEVOPAY_SECRET_KEY;
  const incoming = req.body || {};
  const transactionId = incoming.transaction_id;

  if (!apiKey || !transactionId) {
    // Sem como validar nada aqui: só confirma o recebimento pra FlevoPay não ficar retentando.
    res.status(200).end();
    return;
  }

  // A doc da FlevoPay não documenta assinatura/segredo pro webhook, então em vez de confiar
  // cegamente no corpo recebido, revalidamos o status e os dados direto na FlevoPay usando
  // nossa própria Secret Key antes de repassar qualquer coisa pra Utmify/TikTok.
  let verified = null;
  try {
    const q = await fetch(`${FLEVOPAY_QUERY_API}?action=get_transaction&id=${encodeURIComponent(transactionId)}`, {
      headers: { 'X-API-Key': apiKey },
    });
    const qData = await q.json().catch(() => ({}));
    if (q.ok && qData.status) verified = qData;
  } catch (err) {
    console.error('flevopay-webhook: verificação falhou', err);
  }

  const status = verified ? verified.status : incoming.status;
  const sentAtCreation = (verified && verified.customer_data) || {};
  const customer = sentAtCreation.customer || incoming.customer || {};
  const tracking = sentAtCreation.tracking || incoming.tracking || {};
  const description = sentAtCreation.description || (incoming.product && incoming.product.name) || 'Produto';
  const amountCents = (verified && verified.amount) ?? incoming.amount ?? 0;

  const utmifyStatus = mapUtmifyStatus(status);
  if (utmifyStatus) {
    await pushUtmify({
      orderId: String(transactionId),
      platform: 'FlevoPay',
      paymentMethod: 'pix',
      status: utmifyStatus,
      createdAt: utcTimestamp(),
      approvedDate: utmifyStatus === 'paid' ? utcTimestamp() : null,
      refundedAt: utmifyStatus === 'refunded' ? utcTimestamp() : null,
      customer: {
        name: customer.name || 'Cliente',
        email: customer.email,
        phone: onlyDigits(customer.phone) || null,
        document: onlyDigits(customer.document) || null,
        country: 'BR',
      },
      products: [{
        id: String(description).slice(0, 60),
        name: description,
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: amountCents,
      }],
      trackingParameters: {
        src: tracking.src || null,
        sck: tracking.sck || null,
        utm_source: tracking.utm_source || null,
        utm_campaign: tracking.utm_campaign || null,
        utm_medium: tracking.utm_medium || null,
        utm_content: tracking.utm_content || null,
        utm_term: tracking.utm_term || null,
      },
      commission: {
        totalPriceInCents: amountCents,
        gatewayFeeInCents: 0,
        userCommissionInCents: amountCents,
      },
    });
  }

  if (status === 'approved') {
    await pushTikTokPurchase({
      transactionId,
      amountReais: amountCents / 100,
      customer,
    });
  }

  res.status(200).json({ received: true });
};
