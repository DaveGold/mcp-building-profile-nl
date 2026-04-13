/**
 * MCP tool: get_building_profile
 *
 * Combines BAG (Kadaster) and EP-Online (RVO) data into a single building
 * profile. Looks up by postcode + huisnummer.
 *
 * Flow: PDOK Locatieserver → BAG OGC v2 (VBO + Pand) → EP-Online V5.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../logger.js';
import type { BagClient } from '../clients/bag-client.js';
import type { EpOnlineClient } from '../clients/ep-online-client.js';
import { selectBestLabel } from '../domain/select-best-label.js';
import { generateAlerts } from '../domain/generate-alerts.js';
import { buildProfile, emptyProfile } from '../domain/build-profile.js';

// ── Description ──────────────────────────────────────────────────────────────

const description = `\
RETURNS:
Building profile combining BAG data (bouwjaar, oppervlakte, gebruiksdoel, status, coordinates) and EP-Online energy label data (energieklasse, energie_index or EP-1/EP-2, CO₂ emissie, warmtebehoefte, BENG eisen, SBI sector description, gebouwtype, EMG forfaitair). All data from a single postcode + huisnummer lookup.

WHEN TO USE:
- "Wat voor gebouw staat op [adres]?"
- "Heeft dit gebouw een energielabel?"
- "Check het bouwjaar en oppervlakte van [adres]"
- Before starting an energy analysis — get building context first (bouwjaar, label, oppervlakte)

WHEN NOT TO USE:
- You already have the building profile and need energy meter data (this server does not provide that — see the Energiepartners / Priva ecosystem separately).

QUERY STRATEGY:
1. Postcode must be 4 digits + 2 uppercase letters, no space (e.g. "3543AR"). Huisnummer is the integer only — no letter.
2. If matchStatus = 'multiple_vbos': retry with huisletter (e.g. "A") or toevoeging (e.g. "I", "bis") to get the specific unit.
3. If matchStatus = 'not_found': verify postcode format (no spaces, uppercase). Some addresses use toevoeging instead of huisletter.
4. EP-Online coverage: most labeled utility buildings (kantoor, industrie) have data. Residential without recent certification often lacks a label — energielabel null is normal for pre-2008 homes.
5. Large panden (aantal_verblijfsobjecten > 10, e.g. shopping centers, office parks, care complexes): the returned VBO is the first match — it may be an individual unit with a small oppervlakte_m2. The energielabel and bouwjaar are pand-level and reliable; oppervlakte_m2 is VBO-level and may represent only one unit. For the full-building area, query by huisletter/toevoeging or use BAG directly.

INTERPRETATION:
Which fields are populated depends on the berekeningstype:
- NTA 8800 (labels issued after Dec 2021): ep1, ep2, aandeel_hernieuwbaar, warmtebehoefte, compactheid, gebruiksoppervlakte populated. energie_index = null. EMG forfaitair populated for utiliteitsbouw only (null for woningbouw). sbi_code = null.
- NEN 7120 / ISSO 75.3 (commercial buildings, labels before Dec 2021): energie_index populated; ep1/ep2/warmtebehoefte = null. berekend_energieverbruik inflated (200–1200+ kWh/m²). EMG forfaitair = null. sbi_code = full-text sector description.
- Nader Voorschrift (residential labels before 2021): energie_index populated. CRITICAL: berekend_energieverbruik and co2_emissie use DIFFERENT UNITS — values of 80,000–100,000 are MJ total building, NOT kWh/m². Do NOT benchmark.
- BENG eisen (eis_*): only for new-build BENG certification permits. Almost always null for existing buildings.
- gebouwtype/gebouwsubtype: only populated for Woningbouw (residential). Null for all Utiliteitsbouw.
- matchStatus 'exact': single VBO found, high confidence
- matchStatus 'multiple_vbos': multiple verblijfsobjecten at this address. Profile shows the first match — use huisletter/toevoeging to target a specific unit.
- matchStatus 'not_found': no BAG match — check postcode format (4 digits + 2 uppercase letters) and huisnummer
- energielabel null: no registered label in EP-Online (common for older or unlabeled buildings)
- ep1_energiebehoefte_kwh_m2 (NTA 8800 only): Paris Proof 2040 targets — kantoor: 70 kWh/m², woningbouw: 100 kWh/m². No standardized target for onderwijs, gezondheidszorg, industrie.
- energie_index (pre-NTA 8800): the main performance metric for most existing buildings. EI < 1.2 = A or better; 1.4–1.8 = C; >2.7 = G. No Paris Proof kWh/m² equivalent.
- gebruiksoppervlakte_thermische_zone_m2 (NTA 8800 only) vs oppervlakte_m2 (BAG): BAG = gross floor area; EP-Online = thermal zone area (10–30% lower). Use EP-Online area for kWh/m² benchmarking against EP-1.
- label_geldig_tot in the past: label expired, heropname may be needed for Label C obligation compliance
- op_basis_van_referentiegebouw = true: label is based on a reference building calculation (less accurate)
- vbo_status not "Verblijfsobject in gebruik": building may be vacant/demolished — verify analysis relevance
- sbi_code: full-text sector description — NOT a numeric SBI code. Present for ISSO 75.3/NEN 7120 labels (SBI is an input to those methods). Usually null for NTA 8800 labels.
- ep2_fossiel_emg_forfaitair_kwh_m2 vs ep2_fossiel_kwh_m2: delta shows how standardized forfaitaire area-bound factors compare to the actual calculation. Delta can go EITHER direction.
- ep_online_bouwjaar vs bouwjaar: discrepancy may indicate renovation or partial rebuild.

ALERTS: Always check interpretation.alerts — they contain bouwjaar era warnings (suppressed for good labels A/A+/A++/A+++/A++++), multiple-VBO disambiguation, large pand oppervlakte warning (>10 VBOs), Paris Proof threshold breaches (differentiated by gebouwklasse), label expiry notices, BENG compliance violations, VBO status warnings, bouwjaar discrepancies, and district heating impact notes. For residential buildings alerts also include an estimated annual gas consumption (m³), total CO₂ emission (kg/year), and a warmtepomp-geschiktheidsindicatie based on warmtebehoefte.`;

// ── Input schema ─────────────────────────────────────────────────────────────

const inputSchema = {
  postcode: z
    .string()
    .regex(/^\d{4}[A-Z]{2}$/)
    .describe('Postcode in P6 formaat zonder spatie (bijv. 3751LN)'),
  huisnummer: z.number().int().positive().describe('Huisnummer (alleen getal)'),
  huisletter: z.string().optional().describe('Huisletter (bijv. A, B)'),
  toevoeging: z.string().optional().describe('Huisnummertoevoeging (bijv. bis, I, II)'),
};

// ── Output schema (single source of truth for the profile shape) ─────────────

export const outputSchema = z.object({
  matchStatus: z
    .enum(['exact', 'multiple_vbos', 'not_found'])
    .describe("'exact' = single match, 'multiple_vbos' = ambiguous (apartments), 'not_found' = no BAG result"),
  candidateCount: z.number().describe('Number of VBOs found at this address'),
  labelCount: z.number().describe('Number of EP-Online labels found'),
  adres: z.string().describe('Full formatted address from BAG'),
  gemeente: z.string().nullable().describe('Municipality name (gemeente)'),
  provincie: z.string().nullable().describe('Province name (provincie)'),
  oppervlakte_m2: z.number().nullable().describe('Floor area in m² from BAG verblijfsobject'),
  gebruiksdoel: z
    .string()
    .nullable()
    .describe('Building function(s), comma-separated (woonfunctie, kantoorfunctie, industriefunctie, etc.)'),
  coordinaten: z
    .object({
      lat: z.number().describe('Latitude (WGS84)'),
      lon: z.number().describe('Longitude (WGS84)'),
    })
    .nullable()
    .describe('Geographic coordinates from BAG'),
  bag_vbo_id: z.string().nullable().describe('BAG verblijfsobject identificatie (16 digits)'),
  vbo_status: z.string().nullable().describe('BAG verblijfsobject status'),
  bouwjaar: z.number().nullable().describe('Construction year from BAG pand'),
  pand_status: z.string().nullable().describe('Pand status'),
  aantal_verblijfsobjecten: z
    .number()
    .nullable()
    .describe('Number of verblijfsobjecten in this pand — >1 indicates multi-tenant building'),
  bag_pand_id: z.string().nullable().describe('BAG pand identificatie (16 digits)'),
  energielabel: z
    .string()
    .nullable()
    .describe('Energy label letter (A++++, A, B, C, D, E, F, G) or null if not registered'),
  ep1_energiebehoefte_kwh_m2: z
    .number()
    .nullable()
    .describe('EP-1: energy demand in kWh/m²/year. Paris Proof 2040 target for offices: 70 kWh/m²'),
  ep2_fossiel_kwh_m2: z.number().nullable().describe('EP-2: primary fossil energy in kWh/m²/year'),
  aandeel_hernieuwbaar_pct: z.number().nullable().describe('Share of renewable energy (%)'),
  co2_emissie_kg_m2: z
    .number()
    .nullable()
    .describe(
      'Calculated CO₂ emission. NTA 8800: kg CO₂/m²/year. Nader Voorschrift (residential): kg CO₂/year TOTAL building — do NOT use as per-m² benchmark.'
    ),
  berekend_energieverbruik_kwh_m2: z
    .number()
    .nullable()
    .describe(
      'Theoretical total energy consumption (NOT measured). Unit depends on berekeningstype — see INTERPRETATION block.'
    ),
  warmtebehoefte_kwh_m2: z
    .number()
    .nullable()
    .describe('Net heat demand in kWh/m²/year — key metric for heat pump sizing'),
  temperatuuroverschrijding: z
    .number()
    .nullable()
    .describe('Overheating risk indicator (TOjuli/GTO). 0 = no risk, >1.5 = significant overheating risk.'),
  compactheid: z
    .number()
    .nullable()
    .describe(
      'Thermal envelope compactness ratio (Als/Ag). Lower = more compact = less heat loss per m².'
    ),
  gebruiksoppervlakte_thermische_zone_m2: z
    .number()
    .nullable()
    .describe('Usable floor area of the thermal zone in m² (EP-Online).'),
  gebouwklasse: z
    .string()
    .nullable()
    .describe("'Woningbouw' = residential, 'Utiliteitsbouw' = non-residential."),
  soort_opname: z.string().nullable().describe('Assessment type (NTA 8800 only)'),
  berekeningstype: z.string().nullable().describe('Calculation standard (NTA 8800:2024, NEN 7120, Nader Voorschrift, ...)'),
  label_status: z.string().nullable().describe("'Bestaand' (existing) or 'Nieuw' (new construction)"),
  op_basis_van_referentiegebouw: z
    .boolean()
    .nullable()
    .describe('True = label uses reference building calculation (less accurate).'),
  label_geldig_tot: z.string().nullable().describe('Label expiry date (ISO 8601)'),
  label_opnamedatum: z.string().nullable().describe('Label assessment date (ISO 8601)'),
  label_registratiedatum: z.string().nullable().describe('Label registration date (ISO 8601)'),
  gebouwtype: z
    .string()
    .nullable()
    .describe('Residential building type (Woningbouw only). Null for utiliteitsbouw.'),
  gebouwsubtype: z.string().nullable().describe('Refinement of gebouwtype (residential only).'),
  sbi_code: z
    .string()
    .nullable()
    .describe('Sector description (NEN 7120 / ISSO 75.3 only). Full text, not a numeric SBI code.'),
  energie_index: z
    .number()
    .nullable()
    .describe('Energy Index (EI) from pre-NTA 8800 labels (NEN 7120 / ISSO 82).'),
  ep2_fossiel_emg_forfaitair_kwh_m2: z
    .number()
    .nullable()
    .describe('EP-2 with standardized area-bound measures (stadsverwarming, collectief WKO/PV). NTA 8800 utiliteitsbouw only.'),
  aandeel_hernieuwbaar_emg_forfaitair_pct: z
    .number()
    .nullable()
    .describe('Renewable share with standardized area-bound measures (%). NTA 8800 utiliteitsbouw only.'),
  eis_energiebehoefte_kwh_m2: z
    .number()
    .nullable()
    .describe('BENG-1 legal max — only populated for new-build BENG permits.'),
  eis_primaire_fossiele_energie_kwh_m2: z
    .number()
    .nullable()
    .describe('BENG-2 legal max — only for new-build BENG permits.'),
  eis_aandeel_hernieuwbare_energie_pct: z
    .number()
    .nullable()
    .describe('BENG-3 legal minimum renewable share — only for new-build BENG permits.'),
  certificaathouder: z
    .string()
    .nullable()
    .describe('Name of the EP advisor / certificate holder who registered the label.'),
  ep_online_bouwjaar: z
    .number()
    .nullable()
    .describe('Construction year as registered in EP-Online. Compare with BAG bouwjaar to spot renovations.'),
  alerts: z.array(z.string()).describe('Advisory alerts based on building characteristics'),
});

export type BuildingProfile = z.infer<typeof outputSchema>;

// ── Tool registration ────────────────────────────────────────────────────────

/** Minimum surface of the BAG client used by this tool. Eases testing. */
export type BagClientLike = Pick<BagClient, 'findAddress' | 'getVerblijfsobject' | 'getPand'>;

/** Minimum surface of the EP-Online client used by this tool. Eases testing. */
export type EpOnlineClientLike = Pick<EpOnlineClient, 'getByBagVboId'>;

export function registerGetBuildingProfileTool(
  server: McpServer,
  bagClient: BagClientLike,
  epOnlineClient: EpOnlineClientLike
): void {
  server.registerTool(
    'get_building_profile',
    {
      title: 'Gebouwprofiel (BAG + Energielabel)',
      description,
      inputSchema: z.object(inputSchema),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: { postcode: string; huisnummer: number; huisletter?: string; toevoeging?: string }) => {
      const ok = (profile: BuildingProfile) => ({
        structuredContent: profile,
        content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }],
      });

      try {
        const addresses = await bagClient.findAddress(
          args.postcode,
          args.huisnummer,
          args.huisletter,
          args.toevoeging
        );

        if (addresses.length === 0) {
          const adres = `${args.postcode} ${args.huisnummer}${args.huisletter ?? ''}${args.toevoeging ? ' ' + args.toevoeging : ''}`;
          return ok({
            ...emptyProfile(adres),
            alerts: [
              'Geen adres gevonden in BAG. Controleer postcode (4 cijfers + 2 hoofdletters) en huisnummer.',
            ],
          });
        }

        const bestAddress = addresses[0];

        // VBO + EP-Online both only need the VBO id. Pand lookup chains off VBO.
        const vboPromise = bagClient.getVerblijfsobject(bestAddress.vboId);
        const epPromise = epOnlineClient.getByBagVboId(bestAddress.vboId);
        const pandPromise = vboPromise.then((vbo) =>
          vbo && vbo.pandLinks.length > 0 ? bagClient.getPand(vbo.pandLinks[0]) : null
        );

        const [vbo, labels, pand] = await Promise.all([vboPromise, epPromise, pandPromise]);
        const bestLabel = selectBestLabel(labels);

        const profile = buildProfile({
          matchStatus: addresses.length === 1 ? 'exact' : 'multiple_vbos',
          candidateCount: addresses.length,
          address: bestAddress,
          vbo,
          pand,
          label: bestLabel,
          labelCount: labels.length,
        });

        return ok({ ...profile, alerts: generateAlerts(profile) });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('tool.error', { tool: 'get_building_profile', error: errorMessage });
        return {
          content: [{ type: 'text' as const, text: `Error in get_building_profile: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );
}
