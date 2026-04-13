/**
 * Pick the best EP-Online label when a building has multiple registered labels.
 *
 * A single building can have several labels in EP-Online — e.g. an expired one
 * from the prior owner plus a newly registered one. Prefer still-valid labels
 * over expired ones; within that, prefer the most recently recorded one.
 */

import type { PandEnergielabelV5 } from '../clients/ep-online-client.js';

export function selectBestLabel(labels: PandEnergielabelV5[]): PandEnergielabelV5 | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];

  // Parse dates rather than lex-comparing strings — EP-Online mostly returns
  // full timestamps, but a date-only value would misorder on its expiry day
  // due to null-padding in string compare.
  const now = Date.now();
  const parse = (iso: string | null | undefined): number => {
    if (!iso) return NaN;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : NaN;
  };
  const isValid = (iso: string | null | undefined): boolean => {
    const t = parse(iso);
    return Number.isFinite(t) && t > now;
  };

  const sorted = [...labels].sort((a, b) => {
    const aValid = isValid(a.Geldig_tot) ? 1 : 0;
    const bValid = isValid(b.Geldig_tot) ? 1 : 0;
    if (aValid !== bValid) return bValid - aValid;
    const aOp = parse(a.Opnamedatum);
    const bOp = parse(b.Opnamedatum);
    // NaN sorts last (treat missing opnamedatum as oldest)
    return (Number.isFinite(bOp) ? bOp : -Infinity) - (Number.isFinite(aOp) ? aOp : -Infinity);
  });

  return sorted[0];
}
