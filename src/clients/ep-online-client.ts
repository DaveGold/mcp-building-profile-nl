/**
 * EP-Online V5 API client (RVO energielabels)
 *
 * Looks up registered energy labels (energieprestatiecertificaten) by BAG VBO ID.
 * API key authentication via Authorization header.
 *
 * Upstream responses are parsed with Zod — drift in the EP-Online schema
 * throws here rather than silently producing wrong output.
 *
 * API docs: https://public.ep-online.nl/swagger/v5/swagger.json
 * Register for a free key at: https://public.ep-online.nl
 */

import { z } from 'zod';
import { logger } from '../logger.js';

const EP_ONLINE_BASE_URL = 'https://public.ep-online.nl/api/v5';
const DEFAULT_TIMEOUT_MS = 30_000;

// ── Upstream schema ─────────────────────────────────────────────────────────
// Only the fields we actually consume downstream. z.object strips unknown keys
// by default, so extra fields from EP-Online pass through without rejection.

const pandEnergielabelV5Schema = z.object({
  Pand_opname_id: z.number().nullable().optional(),
  Energieklasse: z.string().nullable().optional(),
  Energiebehoefte: z.number().nullable().optional(),
  PrimaireFossieleEnergie: z.number().nullable().optional(),
  Aandeel_hernieuwbare_energie: z.number().nullable().optional(),
  Geldig_tot: z.string().nullable().optional(),
  Opnamedatum: z.string().nullable().optional(),
  Registratiedatum: z.string().nullable().optional(),
  Berekeningstype: z.string().nullable().optional(),
  Gebouwklasse: z.string().nullable().optional(),
  Bouwjaar: z.number().nullable().optional(),
  Gebruiksoppervlakte_thermische_zone: z.number().nullable().optional(),
  BerekendeCO2Emissie: z.number().nullable().optional(),
  BerekendeEnergieverbruik: z.number().nullable().optional(),
  Warmtebehoefte: z.number().nullable().optional(),
  Temperatuuroverschrijding: z.number().nullable().optional(),
  Compactheid: z.number().nullable().optional(),
  Soort_opname: z.string().nullable().optional(),
  Status: z.string().nullable().optional(),
  Op_basis_van_referentiegebouw: z.boolean().nullable().optional(),
  Gebouwtype: z.string().nullable().optional(),
  Gebouwsubtype: z.string().nullable().optional(),
  SBIcode: z.string().nullable().optional(),
  EnergieIndex: z.number().nullable().optional(),
  Primaire_fossiele_energie_EMG_forfaitair: z.number().nullable().optional(),
  Aandeel_hernieuwbare_energie_EMG_forfaitair: z.number().nullable().optional(),
  Eis_energiebehoefte: z.number().nullable().optional(),
  Eis_primaire_fossiele_energie: z.number().nullable().optional(),
  Eis_aandeel_hernieuwbare_energie: z.number().nullable().optional(),
  Certificaathouder: z.string().nullable().optional(),
});

export type PandEnergielabelV5 = z.infer<typeof pandEnergielabelV5Schema>;

export interface EpOnlineClientOptions {
  /** API key. If omitted, reads process.env.EP_ONLINE_API_KEY. */
  apiKey?: string;
  /** Per-request timeout in ms. Default 30 s. */
  timeoutMs?: number;
}

export class EpOnlineClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: EpOnlineClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.EP_ONLINE_API_KEY ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!this.apiKey) {
      throw new Error(
        'EP-Online client: missing API key.\n\n' +
          'Register for a free key at https://public.ep-online.nl\n' +
          'Then set EP_ONLINE_API_KEY in your environment (or .env file), or ' +
          'pass { apiKey } to new EpOnlineClient(...).'
      );
    }
  }

  /**
   * Look up energy labels by BAG VBO ID (adresseerbaar object ID, 16 digits).
   * Returns [] when no label is registered (404 from upstream).
   */
  async getByBagVboId(bagVboId: string): Promise<PandEnergielabelV5[]> {
    const url = `${EP_ONLINE_BASE_URL}/PandEnergielabel/AdresseerbaarObject/${encodeURIComponent(bagVboId)}`;

    const response = await fetch(url, {
      headers: { Authorization: this.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 404) return [];

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const err = (await response.json()) as Record<string, string>;
        detail = err.title || err.detail || JSON.stringify(err);
      } catch {
        /* ignore */
      }
      logger.warn('ep_online.api_error', { bagVboId, status: response.status, detail });
      throw new Error(`EP-Online API error (${response.status}): ${detail}`);
    }

    const raw = await response.json();
    // API returns an array directly, or a single object — normalize, then validate.
    const arr = Array.isArray(raw) ? raw : [raw];
    return z.array(pandEnergielabelV5Schema).parse(arr);
  }
}
