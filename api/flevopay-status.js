const FLEVOPAY_API = 'https://app.flevopay.com.br/api/v1/query';

function mapStatus(rawStatus) {
  switch (rawStatus) {
    case 'approved':
      return 'paid';
    case 'failed':
    case 'refused':
    case 'refunded':
    case 'chargeback':
      return 'failed';
    default:
      return 'pending';
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

  const { invoiceId } = req.body || {};
  if (!invoiceId) {
    res.status(400).json({ message: 'invoiceId ausente.' });
    return;
  }

  try {
    const url = `${FLEVOPAY_API}?action=get_transaction&id=${encodeURIComponent(invoiceId)}`;
    const response = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      res.status(200).json({ status: 'pending' });
      return;
    }

    res.status(200).json({ status: mapStatus(data.status) });
  } catch (err) {
    res.status(200).json({ status: 'pending' });
  }
};
