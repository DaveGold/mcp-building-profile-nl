import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BagClient } from '../src/clients/bag-client.js';
import { EpOnlineClient } from '../src/clients/ep-online-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BagClient.findAddress', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps PDOK Locatieserver /free response to BagAddress rows', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        response: {
          numFound: 1,
          docs: [
            {
              nummeraanduiding_id: '0344200000000001',
              adresseerbaarobject_id: '0344010000000001',
              straatnaam: 'Middenwetering',
              huisnummer: 1,
              postcode: '3543AR',
              woonplaatsnaam: 'Utrecht',
              weergavenaam: 'Middenwetering 1, 3543AR Utrecht',
              gemeentenaam: 'Utrecht',
              provincienaam: 'Utrecht',
            },
          ],
        },
      })
    ) as typeof fetch;

    const client = new BagClient();
    const addresses = await client.findAddress('3543AR', 1);
    expect(addresses).toHaveLength(1);
    expect(addresses[0].vboId).toBe('0344010000000001');
    expect(addresses[0].gemeente).toBe('Utrecht');
  });
});

describe('BagClient.getVerblijfsobject', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Regression: BAG OGC v2 returns gebruiksdoel as an array when the VBO has
  // multiple functions but as a comma-separated string when it has one. Both
  // shapes must round-trip to a string[] without throwing at the Zod boundary.
  it('accepts gebruiksdoel as a comma-separated string', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        features: [
          {
            properties: {
              identificatie: '0344010000000001',
              oppervlakte: 500,
              gebruiksdoel: 'kantoorfunctie',
              'pand.href': ['https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items/0344100000000001'],
              status: 'Verblijfsobject in gebruik',
            },
            geometry: { type: 'Point', coordinates: [5.12, 52.08] },
          },
        ],
      })
    ) as typeof fetch;

    const vbo = await new BagClient().getVerblijfsobject('0344010000000001');
    expect(vbo?.gebruiksdoel).toEqual(['kantoorfunctie']);
  });

  it('accepts gebruiksdoel as an array of strings', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        features: [
          {
            properties: {
              identificatie: '0344010000000001',
              oppervlakte: 500,
              gebruiksdoel: ['industriefunctie', 'kantoorfunctie'],
              'pand.href': ['https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items/0344100000000001'],
              status: 'Verblijfsobject in gebruik',
            },
            geometry: { type: 'Point', coordinates: [5.12, 52.08] },
          },
        ],
      })
    ) as typeof fetch;

    const vbo = await new BagClient().getVerblijfsobject('0344010000000001');
    expect(vbo?.gebruiksdoel).toEqual(['industriefunctie', 'kantoorfunctie']);
  });
});

describe('EpOnlineClient.getByBagVboId', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.EP_ONLINE_API_KEY = 'test-key';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.EP_ONLINE_API_KEY;
  });

  it('returns [] on 404 (no label registered — not an error)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;
    const client = new EpOnlineClient();
    const labels = await client.getByBagVboId('0344010000000001');
    expect(labels).toEqual([]);
  });

  it('normalizes a single-object response into an array', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        Pand_opname_id: 12345,
        Energieklasse: 'A',
        Energiebehoefte: 45,
        PrimaireFossieleEnergie: 30,
        Aandeel_hernieuwbare_energie: 60,
        Geldig_tot: '2030-01-01T00:00:00Z',
      })
    ) as typeof fetch;

    const client = new EpOnlineClient();
    const labels = await client.getByBagVboId('0344010000000001');
    expect(labels).toHaveLength(1);
    expect(labels[0].Energieklasse).toBe('A');
  });
});
