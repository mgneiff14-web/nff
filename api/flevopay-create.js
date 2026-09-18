const FLEVOPAY_API = 'https://app.flevopay.com.br/api/v1/transaction';
const UTMIFY_API = 'https://api.utmify.com.br/api-credentials/orders';

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function utcTimestamp(date) {
  return (date || new Date()).toISOString().slice(0, 19).replace('T', ' ');
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
    if (!r.ok) console.error('Utmify create push failed', r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error('Utmify create push error', err);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.FLEVOPAY_SECRET_KEY;
  if (!apiKey) {
    res.status(500).json({ message: 'FlevoPay não configurado (defina FLEVOPAY_SECRET_KEY nas variáveis de ambiente da Vercel).' });
    return;
  }

  const body = req.body || {};
  const { amountCents, externalId, payer, items, tracking } = body;
  const item = Array.isArray(items) && items[0] ? items[0] : {};
  const shipping = tracking && tracking.shipping;
  const utm = (tracking && tracking.utm) || {};

  if (!amountCents || !externalId || !payer || !payer.cpf || !payer.email || !payer.phone) {
    res.status(400).json({ message: 'Dados obrigatórios ausentes.' });
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';

  const payload = {
    amount: amountCents,
    description: item.name || 'Pedido',
    reference: externalId,
    source: 'api_externa',
    customer: {
      name: payer.name || 'Cliente',
      email: payer.email,
      document: onlyDigits(payer.cpf),
      phone: onlyDigits(payer.phone),
    },
  };

  if (host) payload.postback_url = `${proto}://${host}/api/flevopay-webhook`;

  if (shipping) {
    payload.address = {
      street: shipping.rua || undefined,
      number: shipping.numero || undefined,
      complement: shipping.complemento || undefined,
      neighborhood: shipping.bairro || undefined,
      city: shipping.cidade || undefined,
      state: shipping.estado || undefined,
      zipcode: shipping.cep || undefined,
    };
  }

  payload.tracking = {
    utm_source: utm.utm_source || undefined,
    utm_medium: utm.utm_medium || undefined,
    utm_campaign: utm.utm_campaign || undefined,
    utm_content: utm.utm_content || undefined,
    utm_term: utm.utm_term || undefined,
  };

  let data;
  try {
    const response = await fetch(FLEVOPAY_API, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await response.json().catch(() => ({}));
    if (!response.ok || !data.qr_code) {
      res.status(response.status && response.status >= 400 ? response.status : 502)
        .json({ message: data.message || 'Não foi possível gerar o Pix.' });
      return;
    }
  } catch (err) {
    res.status(502).json({ message: 'Falha ao conectar com o FlevoPay.' });
    return;
  }

  // Registra o pedido como "aguardando pagamento" na Utmify antes de responder,
  // pra garantir que a chamada saia mesmo em ambiente serverless (nada roda depois do res.json).
  await pushUtmify({
    orderId: String(data.transaction_id),
    platform: 'FlevoPay',
    paymentMethod: 'pix',
    status: 'waiting_payment',
    createdAt: utcTimestamp(),
    approvedDate: null,
    refundedAt: null,
    customer: {
      name: payer.name || 'Cliente',
      email: payer.email,
      phone: onlyDigits(payer.phone) || null,
      document: onlyDigits(payer.cpf) || null,
      country: 'BR',
    },
    products: [{
      id: item.name ? String(item.name).slice(0, 60) : 'produto',
      name: item.name || 'Produto',
      planId: null,
      planName: null,
      quantity: item.quantity || 1,
      priceInCents: amountCents,
    }],
    trackingParameters: {
      src: utm.src || null,
      sck: utm.sck || null,
      utm_source: utm.utm_source || null,
      utm_campaign: utm.utm_campaign || null,
      utm_medium: utm.utm_medium || null,
      utm_content: utm.utm_content || null,
      utm_term: utm.utm_term || null,
    },
    commission: {
      totalPriceInCents: amountCents,
      gatewayFeeInCents: 0,
      userCommissionInCents: amountCents,
    },
  });

  res.status(200).json({
    invoiceId: data.transaction_id,
    qrcode: data.qr_code,
    qrcodeBase64: data.qr_code_base64,
    expirationDate: data.expires_at,
  });
};
