// Parses a pasted Nigerian bank SMS/app alert into an amount + a
// probable sender name. No bank connection — the owner just copies
// the alert text from their bank app/SMS and pastes it in.
//
// Handles common formats from GTBank, Access, Zenith, UBA, OPay,
// Palmpay, Kuda, Moniepoint etc. — they all roughly say
// "<AMOUNT> credited ... from/by <NAME> ..." in some order.

export interface ParsedAlert {
  amount: number | null;
  senderName: string | null;
  raw: string;
}

export function parseBankAlert(text: string): ParsedAlert {
  const raw = text.trim();

  // ---- amount: ₦ / NGN / N followed by digits, or a bare 1,234.56 ----
  const amountMatch = raw.match(/(?:₦|NGN|N)\s?([\d,]+(?:\.\d{1,2})?)/i)
    ?? raw.match(/\b([\d]{1,3}(?:,\d{3})+(?:\.\d{1,2})?)\b/);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;

  // ---- sender name: text after "from"/"by"/"narration" up to the next
  //      punctuation or a stop-word (keeps it short and clean) ----
  const nameMatch = raw.match(/(?:from|by|narration:?)\s+([A-Za-z][A-Za-z .'-]{2,40})/i);
  let senderName = nameMatch ? nameMatch[1].trim() : null;
  if (senderName) {
    // trim trailing stop-words banks often append
    senderName = senderName.replace(/\b(ref|transfer|trf|via|to|on|for)\b.*$/i, '').trim();
    if (senderName.length < 3) senderName = null;
  }

  return { amount, senderName, raw };
}

// ---- fuzzy match a parsed alert against a business's unpaid sales ----
export interface MatchCandidate {
  saleId: string;
  customerName: string;
  balance: number;
  totalAmount: number;
  date: string;
  score: number;
}

const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z\s]/g, '').trim();

function nameOverlap(a: string, b: string): boolean {
  const ta = normalize(a).split(/\s+/).filter(Boolean);
  const tb = normalize(b).split(/\s+/).filter(Boolean);
  return ta.some(t => t.length > 2 && tb.includes(t));
}

export function rankMatches(
  parsed: ParsedAlert,
  sales: { id: string; customerName: string; balance: number; totalAmount: number; date: string }[]
): MatchCandidate[] {
  const candidates = sales.map(s => {
    let score = 0;
    if (parsed.amount != null) {
      if (Math.abs(s.balance - parsed.amount) < 1) score += 100;       // pays off exactly
      else if (parsed.amount > 0 && parsed.amount <= s.totalAmount) score += 50; // plausible part payment
    }
    if (parsed.senderName && nameOverlap(parsed.senderName, s.customerName)) score += 40;
    // The age nudge is a tie-breaker between real matches, so it only applies
    // once something has actually matched. Applied unconditionally it scored
    // every open invoice above zero, which defeated the `score > 0` filter
    // below and offered unrelated invoices as candidates for a payment —
    // exactly the way a payment gets applied to the wrong customer.
    if (score > 0) {
      const daysOld = Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000);
      score += Math.min(daysOld / 10, 5);
    }
    return { saleId: s.id, customerName: s.customerName, balance: s.balance, totalAmount: s.totalAmount, date: s.date, score };
  });
  return candidates.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}
