// Döviz kuru: filament fiyatını $ / € olarak girip ₺ maliyet görmek için.
// Kaynak: Frankfurter (ECB kurları, anahtarsız). Yedek: fawazahmed0 currency-api (jsDelivr).
// Son alınan kur tarayıcıda saklanır; internet yoksa o kullanılır.
const KEY = 'stlogi.fx';
const MAX_AGE = 6 * 3600 * 1000;

let fx = null; // { USD: ₺, EUR: ₺, date: 'YYYY-MM-DD', source, fetchedAt }
try { fx = JSON.parse(localStorage.getItem(KEY)); } catch { /* yok say */ }

async function fromFrankfurter() {
  const r = await fetch('https://api.frankfurter.dev/v1/latest?base=TRY&symbols=USD,EUR');
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  return { USD: 1 / j.rates.USD, EUR: 1 / j.rates.EUR, date: j.date, source: 'Frankfurter (ECB)' };
}
async function fromCurrencyApi() {
  const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/try.json');
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  return { USD: 1 / j.try.usd, EUR: 1 / j.try.eur, date: j.date, source: 'currency-api' };
}

/** Kurlar eskiyse (veya force) yeniden alır. Dönüş: güncel kur nesnesi ya da null. */
export async function refreshRates(force = false) {
  if (!force && fx && Date.now() - fx.fetchedAt < MAX_AGE) return fx;
  for (const src of [fromFrankfurter, fromCurrencyApi]) {
    try {
      const v = await src();
      if (!(v.USD > 0 && v.EUR > 0)) continue;
      fx = { ...v, fetchedAt: Date.now() };
      try { localStorage.setItem(KEY, JSON.stringify(fx)); } catch { /* yok say */ }
      return fx;
    } catch { /* sonraki kaynağı dene */ }
  }
  return fx; // son bilinen (olabilir null)
}

export const getRates = () => fx;

/** Verilen para birimindeki tutarı ₺'ye çevirir; kur yoksa null. */
export function toTRY(amount, cur) {
  if (cur === 'TRY') return amount;
  return fx?.[cur] ? amount * fx[cur] : null;
}
