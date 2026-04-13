import { describe, it, expect } from 'vitest';
import { generateAlerts } from '../src/domain/generate-alerts.js';
import type { ProfileCore } from '../src/domain/generate-alerts.js';

// Minimal baseline — every alert rule reads from this shape, so tests set the
// relevant fields and rely on null for everything else.
function baseProfile(overrides: Partial<ProfileCore> = {}): ProfileCore {
  return {
    matchStatus: 'exact',
    candidateCount: 1,
    labelCount: 0,
    adres: 'Teststraat 1, 1234AB Teststad',
    gemeente: null,
    provincie: null,
    oppervlakte_m2: null,
    gebruiksdoel: null,
    coordinaten: null,
    bag_vbo_id: null,
    vbo_status: null,
    bouwjaar: null,
    pand_status: null,
    aantal_verblijfsobjecten: null,
    bag_pand_id: null,
    energielabel: null,
    ep1_energiebehoefte_kwh_m2: null,
    ep2_fossiel_kwh_m2: null,
    aandeel_hernieuwbaar_pct: null,
    co2_emissie_kg_m2: null,
    berekend_energieverbruik_kwh_m2: null,
    warmtebehoefte_kwh_m2: null,
    temperatuuroverschrijding: null,
    compactheid: null,
    gebruiksoppervlakte_thermische_zone_m2: null,
    gebouwklasse: null,
    soort_opname: null,
    berekeningstype: null,
    label_status: null,
    op_basis_van_referentiegebouw: null,
    label_geldig_tot: null,
    label_opnamedatum: null,
    label_registratiedatum: null,
    gebouwtype: null,
    gebouwsubtype: null,
    sbi_code: null,
    energie_index: null,
    ep2_fossiel_emg_forfaitair_kwh_m2: null,
    aandeel_hernieuwbaar_emg_forfaitair_pct: null,
    eis_energiebehoefte_kwh_m2: null,
    eis_primaire_fossiele_energie_kwh_m2: null,
    eis_aandeel_hernieuwbare_energie_pct: null,
    certificaathouder: null,
    ep_online_bouwjaar: null,
    ...overrides,
  };
}

describe('generateAlerts', () => {
  it('suppresses bouwjaar-era alert when the label is A+ or better', () => {
    const alerts = generateAlerts(baseProfile({ bouwjaar: 1975, energielabel: 'A++' }));
    expect(alerts.some((a) => a.includes('Pre-Bouwbesluit'))).toBe(false);
  });

  it('emits pre-1992 era alert when label is mediocre', () => {
    const alerts = generateAlerts(baseProfile({ bouwjaar: 1975, energielabel: 'D' }));
    expect(alerts.some((a) => a.includes('Pre-Bouwbesluit 1992'))).toBe(true);
  });

  it('treats Nader Voorschrift co2_emissie as a total (not per m²)', () => {
    const alerts = generateAlerts(
      baseProfile({
        gebruiksdoel: 'woonfunctie',
        berekeningstype: 'Nader Voorschrift',
        co2_emissie_kg_m2: 4200,
        oppervlakte_m2: 79,
      })
    );
    // Per-m² interpretation would multiply by 79 → ~331k. Total interpretation keeps ~4200.
    const co2Alert = alerts.find((a) => a.includes('CO₂-uitstoot'));
    expect(co2Alert).toBeDefined();
    expect(co2Alert).toMatch(/~4200 kg\/jaar/);
  });

  it('fires Paris Proof office threshold only for offices', () => {
    const officeAlerts = generateAlerts(
      baseProfile({
        ep1_energiebehoefte_kwh_m2: 85,
        gebruiksdoel: 'kantoorfunctie',
      })
    );
    expect(officeAlerts.some((a) => a.includes('Paris Proof 2040 richtwaarde (70'))).toBe(true);

    const industrialAlerts = generateAlerts(
      baseProfile({
        ep1_energiebehoefte_kwh_m2: 85,
        gebruiksdoel: 'industriefunctie',
      })
    );
    expect(industrialAlerts.some((a) => a.includes('Paris Proof'))).toBe(false);
  });

  it('produces a BENG-toetsing summary with ✓ / ✗ markers', () => {
    const alerts = generateAlerts(
      baseProfile({
        eis_energiebehoefte_kwh_m2: 50,
        ep1_energiebehoefte_kwh_m2: 70, // overschrijding
        eis_aandeel_hernieuwbare_energie_pct: 40,
        aandeel_hernieuwbaar_pct: 50, // passes
      })
    );
    const beng = alerts.find((a) => a.startsWith('BENG-toetsing:'));
    expect(beng).toBeDefined();
    expect(beng).toMatch(/BENG-1[\s\S]*OVERSCHRIJDING/);
    expect(beng).toMatch(/BENG-3[\s\S]*✓/);
  });

  it('flags expired labels and multiple-VBO matches', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const alerts = generateAlerts(
      baseProfile({
        matchStatus: 'multiple_vbos',
        candidateCount: 4,
        energielabel: 'C',
        label_geldig_tot: yesterday,
      })
    );
    expect(alerts.some((a) => a.includes('Meerdere verblijfsobjecten (4)'))).toBe(true);
    expect(alerts.some((a) => a.includes('Energielabel is verlopen'))).toBe(true);
  });

  it('does not emit the "no EP label" alert on not_found (EP was never queried)', () => {
    const alerts = generateAlerts(
      baseProfile({
        matchStatus: 'not_found',
        candidateCount: 0,
        energielabel: null,
      })
    );
    expect(alerts.some((a) => a.includes('Geen geregistreerd energielabel'))).toBe(false);
  });

  it('emits the "no EP label" alert when BAG matched but EP-Online returned nothing', () => {
    const alerts = generateAlerts(
      baseProfile({
        matchStatus: 'exact',
        candidateCount: 1,
        labelCount: 0,
        energielabel: null,
        bouwjaar: 2010,
      })
    );
    expect(alerts.some((a) => a.includes('Geen geregistreerd energielabel'))).toBe(true);
  });

  it('does not flag a date-only Geldig_tot as expired on its own valid-through day', () => {
    // A date-only value compared lex against new Date().toISOString() would be
    // shorter than "today-T..." and therefore marked expired. The Date-parsed
    // comparison treats it as midnight UTC of that day, so a far-future
    // date-only value is unambiguously valid.
    const farFutureDateOnly = '2099-12-31';
    const alerts = generateAlerts(
      baseProfile({ energielabel: 'C', label_geldig_tot: farFutureDateOnly })
    );
    expect(alerts.some((a) => a.includes('Energielabel is verlopen'))).toBe(false);
  });
});
