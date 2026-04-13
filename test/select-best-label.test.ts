import { describe, it, expect } from 'vitest';
import { selectBestLabel } from '../src/domain/select-best-label.js';
import type { PandEnergielabelV5 } from '../src/clients/ep-online-client.js';

// All label fields are nullable+optional, so a partial override is a complete label.
function label(overrides: Partial<PandEnergielabelV5>): PandEnergielabelV5 {
  return { ...overrides };
}

describe('selectBestLabel', () => {
  it('prefers a still-valid label over an expired one, even if the expired one is more recent', () => {
    const futureISO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const pastISO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    const valid = label({ Energieklasse: 'B', Geldig_tot: futureISO, Opnamedatum: '2020-01-01' });
    const expired = label({ Energieklasse: 'D', Geldig_tot: pastISO, Opnamedatum: '2023-01-01' });

    expect(selectBestLabel([expired, valid])?.Energieklasse).toBe('B');
  });

  it('tie-breaks on most recent Opnamedatum when both labels have the same validity', () => {
    const futureISO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const older = label({ Energieklasse: 'C', Geldig_tot: futureISO, Opnamedatum: '2020-01-01' });
    const newer = label({ Energieklasse: 'A', Geldig_tot: futureISO, Opnamedatum: '2024-06-01' });

    expect(selectBestLabel([older, newer])?.Energieklasse).toBe('A');
  });

  it('treats a date-only Geldig_tot as valid (parses as Date, not string-compare)', () => {
    // Lex-compare would rank "2099-12-31" < "2099-12-31T..." on that day and
    // could misorder the two — forcing a Date parse fixes it unambiguously.
    const fullTsPast = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const dateOnlyFuture = '2099-12-31';

    const expired = label({ Energieklasse: 'D', Geldig_tot: fullTsPast, Opnamedatum: '2024-01-01' });
    const valid = label({ Energieklasse: 'B', Geldig_tot: dateOnlyFuture, Opnamedatum: '2020-01-01' });

    expect(selectBestLabel([expired, valid])?.Energieklasse).toBe('B');
  });
});
