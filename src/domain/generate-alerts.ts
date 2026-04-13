/**
 * Domain post-processing: turn a BuildingProfile into human-readable alerts.
 *
 * This is where generic upstream data becomes actionable advice:
 *   - "Pre-Bouwbesluit 1992 — waarschijnlijk beperkte isolatiewaarde"
 *   - "EP-1 boven Paris Proof 2040 richtwaarde (70 kWh/m² voor kantoor)"
 *   - BENG compliance pass/fail summary
 *   - Warmtepomp-geschiktheidsindicatie (residential only)
 *
 * Why this lives in the tool (not the agent): these rules depend on
 * non-obvious knowledge of Dutch building regulation eras, unit quirks in
 * different label calculation methods (NTA 8800 vs Nader Voorschrift), and
 * gas-to-kWh conversion factors. Putting them in the server means every agent
 * gets them for free — no prompt engineering required on the caller side.
 */

import type { BuildingProfile } from '../tools/get-building-profile.js';

/** Profile shape without the alerts array it will be merged into. */
export type ProfileCore = Omit<BuildingProfile, 'alerts'>;

export function generateAlerts(profile: ProfileCore): string[] {
  const alerts: string[] = [];

  if (profile.matchStatus === 'multiple_vbos') {
    alerts.push(
      `Meerdere verblijfsobjecten (${profile.candidateCount}) op dit adres — getoond profiel is eerste match. Specificeer huisletter/toevoeging voor exacte match.`
    );
  }

  // Large multi-unit building: oppervlakte_m2 is just one VBO, not the total building
  if (profile.aantal_verblijfsobjecten !== null && profile.aantal_verblijfsobjecten > 10) {
    alerts.push(
      `Groot pand met ${profile.aantal_verblijfsobjecten} verblijfsobjecten — oppervlakte_m2 (${profile.oppervlakte_m2} m²) is slechts één VBO, niet het totale gebouw. Gebruik bouwjaar en energielabel voor kwaliteitsanalyse; gebruik NIET oppervlakte_m2 als benchmark-noemer.`
    );
  }

  if (profile.bouwjaar !== null) {
    // Suppress era alerts when the label already proves good performance
    const goodLabel =
      profile.energielabel !== null &&
      ['A++++', 'A+++', 'A++', 'A+', 'A'].includes(profile.energielabel);

    if (!goodLabel) {
      if (profile.bouwjaar < 1992) {
        alerts.push('Pre-Bouwbesluit 1992 — waarschijnlijk beperkte isolatiewaarde.');
      } else if (profile.bouwjaar < 2003) {
        alerts.push('Pre-EPC — isolatie waarschijnlijk onder huidige norm.');
      } else if (profile.bouwjaar < 2015) {
        alerts.push('Pre-BENG — matige energieprestatie verwacht.');
      }
    }
  }

  if (profile.energielabel) {
    const letter = profile.energielabel.replace(/\+/g, '');
    if (
      ['D', 'E', 'F', 'G'].includes(letter) &&
      profile.gebruiksdoel?.toLowerCase().includes('kantoor')
    ) {
      alerts.push('Mogelijk Label C-relevant — verifieer of kantooraandeel >50% en oppervlakte >100m².');
    }
  }

  if (profile.ep1_energiebehoefte_kwh_m2 !== null) {
    if (profile.ep1_energiebehoefte_kwh_m2 > 150) {
      alerts.push('EP-1 sterk boven benchmark (>150 kWh/m²) — groot besparingspotentieel.');
    } else {
      const isResidential = profile.gebouwklasse === 'Woningbouw';
      const isOffice = profile.gebruiksdoel?.toLowerCase().includes('kantoorfunctie') ?? false;

      if (isResidential && profile.ep1_energiebehoefte_kwh_m2 > 100) {
        alerts.push('EP-1 boven Paris Proof 2040 richtwaarde (100 kWh/m² voor woningbouw).');
      } else if (isOffice && profile.ep1_energiebehoefte_kwh_m2 > 70) {
        alerts.push('EP-1 boven Paris Proof 2040 richtwaarde (70 kWh/m² voor kantoor).');
      }
    }
  }

  if (profile.label_geldig_tot) {
    // Parse as Date — string compare would treat "2026-04-13" as earlier than
    // "2026-04-13T20:00:00.000Z" on its own valid-through day (different length
    // pads null), which would wrongly mark a still-valid label expired.
    const expiry = new Date(profile.label_geldig_tot).getTime();
    if (Number.isFinite(expiry) && expiry < Date.now()) {
      alerts.push('Energielabel is verlopen — heropname kan nodig zijn.');
    }
  }

  // Only emit this alert when EP-Online was actually queried. In the not_found
  // branch we short-circuit after BAG, so a missing label is "never looked up",
  // not "looked up and not there" — conflating the two would mislead the agent.
  if (!profile.energielabel && profile.matchStatus !== 'not_found') {
    alerts.push('Geen geregistreerd energielabel gevonden in EP-Online.');
  }

  if (profile.vbo_status && !profile.vbo_status.toLowerCase().includes('in gebruik')) {
    alerts.push(
      `VBO status: "${profile.vbo_status}" — gebouw mogelijk niet in gebruik. Controleer of analyse relevant is.`
    );
  }

  // BENG compliance summary (only when eisen are available — new-build permits)
  const hasBengEisen =
    profile.eis_energiebehoefte_kwh_m2 !== null ||
    profile.eis_primaire_fossiele_energie_kwh_m2 !== null ||
    profile.eis_aandeel_hernieuwbare_energie_pct !== null;

  if (hasBengEisen) {
    const lines: string[] = ['BENG-toetsing:'];

    if (profile.eis_energiebehoefte_kwh_m2 !== null && profile.ep1_energiebehoefte_kwh_m2 !== null) {
      const pass = profile.ep1_energiebehoefte_kwh_m2 <= profile.eis_energiebehoefte_kwh_m2;
      lines.push(
        `  BENG-1 Energiebehoefte: ${profile.ep1_energiebehoefte_kwh_m2} kWh/m² (max ${profile.eis_energiebehoefte_kwh_m2}) ${pass ? '✓' : '✗ OVERSCHRIJDING'}`
      );
    }

    if (
      profile.eis_primaire_fossiele_energie_kwh_m2 !== null &&
      profile.ep2_fossiel_kwh_m2 !== null
    ) {
      const pass = profile.ep2_fossiel_kwh_m2 <= profile.eis_primaire_fossiele_energie_kwh_m2;
      lines.push(
        `  BENG-2 Fossiel energiegebruik: ${profile.ep2_fossiel_kwh_m2} kWh/m² (max ${profile.eis_primaire_fossiele_energie_kwh_m2}) ${pass ? '✓' : '✗ OVERSCHRIJDING'}`
      );
    }

    if (
      profile.eis_aandeel_hernieuwbare_energie_pct !== null &&
      profile.aandeel_hernieuwbaar_pct !== null
    ) {
      const pass =
        profile.aandeel_hernieuwbaar_pct >= profile.eis_aandeel_hernieuwbare_energie_pct;
      lines.push(
        `  BENG-3 Hernieuwbare energie: ${profile.aandeel_hernieuwbaar_pct}% (min ${profile.eis_aandeel_hernieuwbare_energie_pct}%) ${pass ? '✓' : '✗ NIET GEHAALD'}`
      );
    }

    alerts.push(lines.join('\n'));
  }

  // Bouwjaar cross-check between BAG and EP-Online
  if (
    profile.bouwjaar !== null &&
    profile.ep_online_bouwjaar !== null &&
    profile.bouwjaar !== profile.ep_online_bouwjaar
  ) {
    alerts.push(
      `Bouwjaar discrepantie: BAG ${profile.bouwjaar} vs EP-Online ${profile.ep_online_bouwjaar} — mogelijk renovatie of registratiefout.`
    );
  }

  // District heating / EMG forfaitair insight
  if (profile.ep2_fossiel_emg_forfaitair_kwh_m2 !== null && profile.ep2_fossiel_kwh_m2 !== null) {
    const delta = profile.ep2_fossiel_kwh_m2 - profile.ep2_fossiel_emg_forfaitair_kwh_m2;
    if (delta > 5) {
      alerts.push(
        `Gebiedsgebonden maatregel (stadsverwarming/WKO/collectief PV) verlaagt EP-2 met ${Math.round(delta)} kWh/m².`
      );
    }
  }

  // Woning-specific consumer insights (only for residential buildings)
  const isWoning = profile.gebruiksdoel?.toLowerCase().includes('woonfunctie');
  if (isWoning) {
    if (profile.warmtebehoefte_kwh_m2 !== null && profile.oppervlakte_m2 !== null) {
      const gasM3 = Math.round((profile.warmtebehoefte_kwh_m2 * profile.oppervlakte_m2) / 31.65 / 0.95);
      alerts.push(
        `Geschat gasverbruik: ~${gasM3} m³/jaar (o.b.v. warmtebehoefte ${profile.warmtebehoefte_kwh_m2} kWh/m², oppervlakte ${profile.oppervlakte_m2} m², HR-ketel 95%).`
      );
    }

    if (profile.co2_emissie_kg_m2 !== null && profile.oppervlakte_m2 !== null) {
      const isNaderVoorschrift =
        profile.berekeningstype?.toLowerCase().includes('nader voorschrift') ?? false;
      if (isNaderVoorschrift) {
        // Nader Voorschrift: co2_emissie is already a total (kg/year), not per m²
        const totalCo2 = Math.round(profile.co2_emissie_kg_m2);
        alerts.push(
          `Totale CO₂-uitstoot: ~${totalCo2} kg/jaar (Nader Voorschrift — waarde is totaal gebouw).`
        );
      } else {
        const totalCo2 = Math.round(profile.co2_emissie_kg_m2 * profile.oppervlakte_m2);
        alerts.push(
          `Totale CO₂-uitstoot: ~${totalCo2} kg/jaar (${profile.co2_emissie_kg_m2} kg/m² × ${profile.oppervlakte_m2} m²).`
        );
      }
    }

    if (profile.warmtebehoefte_kwh_m2 !== null) {
      const wb = profile.warmtebehoefte_kwh_m2;
      const indicatie =
        wb < 50
          ? 'zeer geschikt voor warmtepomp'
          : wb < 70
            ? 'geschikt voor warmtepomp'
            : wb < 100
              ? 'geschikt voor warmtepomp mits isolatie-aanpak'
              : 'eerst isoleren voor warmtepomp';
      alerts.push(`Warmtepomp-indicatie: ${indicatie} (warmtebehoefte ${wb} kWh/m²).`);
    }
  }

  return alerts;
}
