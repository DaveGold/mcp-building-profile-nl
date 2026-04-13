/**
 * BAG (Kadaster) client — PDOK Locatieserver + BAG OGC v2
 *
 * Combines two open PDOK APIs (no authentication required):
 *   1. Locatieserver — address geocoding (postcode + huisnummer → VBO ID)
 *   2. BAG OGC v2 — verblijfsobject + pand details
 *
 * Upstream responses are parsed with Zod. If PDOK ever changes the wire
 * format, the failure surfaces here rather than further down the pipeline.
 */

import { z } from 'zod';
import { logger } from '../logger.js';

const LOCATIESERVER_URL = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';
const BAG_OGC_URL = 'https://api.pdok.nl/kadaster/bag/ogc/v2';

const DEFAULT_TIMEOUT_MS = 30_000;

// ── Upstream schemas ────────────────────────────────────────────────────────

const locatieserverDocSchema = z.object({
  nummeraanduiding_id: z.string(),
  adresseerbaarobject_id: z.string(),
  straatnaam: z.string(),
  huisnummer: z.number(),
  huisletter: z.string().optional(),
  huisnummertoevoeging: z.string().optional(),
  postcode: z.string(),
  woonplaatsnaam: z.string(),
  weergavenaam: z.string(),
  gemeentenaam: z.string().optional(),
  provincienaam: z.string().optional(),
});

const locatieserverResponseSchema = z.object({
  response: z.object({
    numFound: z.number(),
    docs: z.array(locatieserverDocSchema),
  }),
});

// BAG OGC v2 returns gebruiksdoel as either a string[] or a comma-separated
// string depending on cardinality — normalize to string[] at parse time.
const gebruiksdoelSchema = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(',').map((s) => s.trim())));

const vboFeatureSchema = z.object({
  properties: z.object({
    identificatie: z.string(),
    // Nullable: VBOs in aanbouw may not have oppervlakte recorded yet.
    oppervlakte: z.number().nullable(),
    gebruiksdoel: gebruiksdoelSchema,
    'pand.href': z.array(z.string()).optional(),
    status: z.string(),
  }),
  geometry: z
    .object({
      type: z.string(),
      coordinates: z.array(z.number()),
    })
    .nullable()
    .optional(),
});

const vboResponseSchema = z.object({
  features: z.array(vboFeatureSchema),
});

const pandResponseSchema = z.object({
  properties: z.object({
    identificatie: z.string(),
    // Nullable: panden in the permit phase may not have bouwjaar recorded yet.
    bouwjaar: z.number().nullable(),
    status: z.string(),
    aantal_verblijfsobjecten: z.number().optional(),
  }),
});

// ── Public types (derived from schemas) ─────────────────────────────────────

export interface BagAddress {
  nummeraanduidingId: string;
  vboId: string;
  street: string;
  houseNumber: number;
  houseLetter: string | null;
  houseNumberAddition: string | null;
  postcode: string;
  city: string;
  weergavenaam: string;
  gemeente: string | null;
  provincie: string | null;
}

export interface BagVerblijfsobject {
  identificatie: string;
  /** null for VBOs still under construction (status "Verblijfsobject in aanbouw"). */
  oppervlakte: number | null;
  gebruiksdoel: string[];
  pandLinks: string[];
  coordinates: [number, number] | null;
  status: string;
}

export interface BagPand {
  identificatie: string;
  /** null for panden in the permit phase (status "Bouwvergunning verleend"). */
  bouwjaar: number | null;
  status: string;
  aantalVerblijfsobjecten: number;
}

export interface BagClientOptions {
  /** Per-request timeout in ms. Default 30 s. */
  timeoutMs?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Escape Solr/Lucene special characters in user-supplied query values. */
function escapeLucene(value: string): string {
  return value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

// ── Client ──────────────────────────────────────────────────────────────────

export class BagClient {
  private readonly timeoutMs: number;

  constructor(options: BagClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Step 1: Find address via PDOK Locatieserver (geocoding).
   *
   * Post-filters the response so huisletter/toevoeging constraints are
   * honored exactly — PDOK's `/free` endpoint ranks by relevance and may
   * return close-but-not-equal matches if the precise one doesn't exist.
   */
  async findAddress(
    postcode: string,
    huisnummer: number,
    huisletter?: string,
    toevoeging?: string
  ): Promise<BagAddress[]> {
    let q = `postcode:${postcode} AND huisnummer:${huisnummer}`;
    if (huisletter) q += ` AND huisletter:${escapeLucene(huisletter)}`;
    if (toevoeging) q += ` AND huisnummertoevoeging:${escapeLucene(toevoeging)}`;

    const params = new URLSearchParams({
      q,
      fq: 'type:adres',
      rows: '10',
      fl: 'nummeraanduiding_id,adresseerbaarobject_id,straatnaam,huisnummer,huisletter,huisnummertoevoeging,postcode,woonplaatsnaam,weergavenaam,gemeentenaam,provincienaam',
    });

    const url = `${LOCATIESERVER_URL}/free?${params}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`PDOK Locatieserver error (${response.status}): ${response.statusText}`);
    }

    const { response: body } = locatieserverResponseSchema.parse(await response.json());

    return body.docs
      .filter((doc) => doc.huisnummer === huisnummer)
      .filter((doc) => (huisletter ? eq(doc.huisletter, huisletter) : true))
      .filter((doc) => (toevoeging ? eq(doc.huisnummertoevoeging, toevoeging) : true))
      .map((doc) => ({
        nummeraanduidingId: doc.nummeraanduiding_id,
        vboId: doc.adresseerbaarobject_id,
        street: doc.straatnaam,
        houseNumber: doc.huisnummer,
        houseLetter: doc.huisletter ?? null,
        houseNumberAddition: doc.huisnummertoevoeging ?? null,
        postcode: doc.postcode,
        city: doc.woonplaatsnaam,
        weergavenaam: doc.weergavenaam,
        gemeente: doc.gemeentenaam ?? null,
        provincie: doc.provincienaam ?? null,
      }));
  }

  /** Step 2: Verblijfsobject details from BAG OGC v2. */
  async getVerblijfsobject(vboId: string): Promise<BagVerblijfsobject | null> {
    const url = `${BAG_OGC_URL}/collections/verblijfsobject/items?identificatie=${vboId}&f=json`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      logger.warn('bag.vbo_fetch_error', { vboId, status: response.status });
      return null;
    }

    const { features } = vboResponseSchema.parse(await response.json());
    const feature = features[0];
    if (!feature) return null;

    const coords =
      feature.geometry?.type === 'Point' && feature.geometry.coordinates.length >= 2
        ? ([feature.geometry.coordinates[0], feature.geometry.coordinates[1]] as [number, number])
        : null;

    return {
      identificatie: feature.properties.identificatie,
      oppervlakte: feature.properties.oppervlakte,
      gebruiksdoel: feature.properties.gebruiksdoel,
      pandLinks: feature.properties['pand.href'] ?? [],
      coordinates: coords,
      status: feature.properties.status,
    };
  }

  /**
   * Step 3: Pand details from BAG OGC v2. Accepts a pand.href relation URL.
   */
  async getPand(pandLink: string): Promise<BagPand | null> {
    const url = new URL(pandLink);
    url.searchParams.set('f', 'json');

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      logger.warn('bag.pand_fetch_error', { pandLink, status: response.status });
      return null;
    }

    const { properties } = pandResponseSchema.parse(await response.json());
    return {
      identificatie: properties.identificatie,
      bouwjaar: properties.bouwjaar,
      status: properties.status,
      aantalVerblijfsobjecten: properties.aantal_verblijfsobjecten ?? 0,
    };
  }
}
