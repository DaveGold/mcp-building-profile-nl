/**
 * Pure mapping from upstream records to a BuildingProfile.
 *
 * Single source of this logic — consumed by the tool handler and the live
 * smoke script. Tests can call it directly without a transport.
 */

import type { BagAddress, BagVerblijfsobject, BagPand } from '../clients/bag-client.js';
import type { PandEnergielabelV5 } from '../clients/ep-online-client.js';
import type { BuildingProfile } from '../tools/get-building-profile.js';

export interface BuildProfileInput {
  matchStatus: 'exact' | 'multiple_vbos';
  candidateCount: number;
  labelCount: number;
  address: BagAddress;
  vbo: BagVerblijfsobject | null;
  pand: BagPand | null;
  label: PandEnergielabelV5 | null;
}

/** Produce a profile *without* the alerts field — caller fills that in. */
export function buildProfile(input: BuildProfileInput): Omit<BuildingProfile, 'alerts'> {
  const { matchStatus, candidateCount, labelCount, address, vbo, pand, label } = input;

  return {
    matchStatus,
    candidateCount,
    labelCount,
    adres: address.weergavenaam,
    gemeente: address.gemeente,
    provincie: address.provincie,
    oppervlakte_m2: vbo?.oppervlakte ?? null,
    gebruiksdoel: vbo?.gebruiksdoel?.join(', ') ?? null,
    coordinaten: vbo?.coordinates ? { lat: vbo.coordinates[1], lon: vbo.coordinates[0] } : null,
    bag_vbo_id: vbo?.identificatie ?? address.vboId,
    vbo_status: vbo?.status ?? null,
    bouwjaar: pand?.bouwjaar ?? null,
    pand_status: pand?.status ?? null,
    aantal_verblijfsobjecten: pand?.aantalVerblijfsobjecten ?? null,
    bag_pand_id: pand?.identificatie ?? null,
    energielabel: label?.Energieklasse ?? null,
    ep1_energiebehoefte_kwh_m2: label?.Energiebehoefte ?? null,
    ep2_fossiel_kwh_m2: label?.PrimaireFossieleEnergie ?? null,
    aandeel_hernieuwbaar_pct: label?.Aandeel_hernieuwbare_energie ?? null,
    co2_emissie_kg_m2: label?.BerekendeCO2Emissie ?? null,
    berekend_energieverbruik_kwh_m2: label?.BerekendeEnergieverbruik ?? null,
    warmtebehoefte_kwh_m2: label?.Warmtebehoefte ?? null,
    temperatuuroverschrijding: label?.Temperatuuroverschrijding ?? null,
    compactheid: label?.Compactheid ?? null,
    gebruiksoppervlakte_thermische_zone_m2: label?.Gebruiksoppervlakte_thermische_zone ?? null,
    gebouwklasse: label?.Gebouwklasse ?? null,
    soort_opname: label?.Soort_opname ?? null,
    berekeningstype: label?.Berekeningstype ?? null,
    label_status: label?.Status ?? null,
    op_basis_van_referentiegebouw: label?.Op_basis_van_referentiegebouw ?? null,
    label_geldig_tot: label?.Geldig_tot ?? null,
    label_opnamedatum: label?.Opnamedatum ?? null,
    label_registratiedatum: label?.Registratiedatum ?? null,
    gebouwtype: label?.Gebouwtype ?? null,
    gebouwsubtype: label?.Gebouwsubtype ?? null,
    sbi_code: label?.SBIcode ?? null,
    energie_index: label?.EnergieIndex ?? null,
    ep2_fossiel_emg_forfaitair_kwh_m2: label?.Primaire_fossiele_energie_EMG_forfaitair ?? null,
    aandeel_hernieuwbaar_emg_forfaitair_pct: label?.Aandeel_hernieuwbare_energie_EMG_forfaitair ?? null,
    eis_energiebehoefte_kwh_m2: label?.Eis_energiebehoefte ?? null,
    eis_primaire_fossiele_energie_kwh_m2: label?.Eis_primaire_fossiele_energie ?? null,
    eis_aandeel_hernieuwbare_energie_pct: label?.Eis_aandeel_hernieuwbare_energie ?? null,
    certificaathouder: label?.Certificaathouder ?? null,
    ep_online_bouwjaar: label?.Bouwjaar ?? null,
  };
}

/**
 * not_found placeholder — every upstream-derived field is null, matchStatus is
 * 'not_found', the caller supplies alerts and adres. Centralized so adding a
 * new field to the profile only requires updating buildProfile() above
 * (emptyProfile delegates).
 */
export function emptyProfile(adres: string): Omit<BuildingProfile, 'alerts'> {
  const stub: BagAddress = {
    nummeraanduidingId: '',
    vboId: '',
    street: '',
    houseNumber: 0,
    houseLetter: null,
    houseNumberAddition: null,
    postcode: '',
    city: '',
    weergavenaam: adres,
    gemeente: null,
    provincie: null,
  };
  return {
    ...buildProfile({
      matchStatus: 'exact', // overwritten below
      candidateCount: 0,
      labelCount: 0,
      address: stub,
      vbo: null,
      pand: null,
      label: null,
    }),
    matchStatus: 'not_found',
    bag_vbo_id: null,
  };
}
