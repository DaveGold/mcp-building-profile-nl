import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import {
  outputSchema,
  type BagClientLike,
  type EpOnlineClientLike,
} from '../src/tools/get-building-profile.js';
import type { BagAddress, BagVerblijfsobject, BagPand } from '../src/clients/bag-client.js';
import type { PandEnergielabelV5 } from '../src/clients/ep-online-client.js';

// Hand-rolled stubs against the *Like types — no `as unknown as` casts.
function stubBag(result: {
  addresses: BagAddress[];
  vbo?: BagVerblijfsobject | null;
  pand?: BagPand | null;
}): BagClientLike {
  return {
    findAddress: async () => result.addresses,
    getVerblijfsobject: async () => result.vbo ?? null,
    getPand: async () => result.pand ?? null,
  };
}

function stubEpOnline(labels: PandEnergielabelV5[]): EpOnlineClientLike {
  return { getByBagVboId: async () => labels };
}

async function connectClientToServer(
  bagClient: BagClientLike,
  epOnlineClient: EpOnlineClientLike
): Promise<Client> {
  const server = createServer({ bagClient, epOnlineClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('get_building_profile (end-to-end over InMemoryTransport)', () => {
  it('returns a validated profile for the happy path', async () => {
    const bag = stubBag({
      addresses: [
        {
          nummeraanduidingId: '0344200000000001',
          vboId: '0344010000000001',
          street: 'Middenwetering',
          houseNumber: 1,
          houseLetter: null,
          houseNumberAddition: null,
          postcode: '3543AR',
          city: 'Utrecht',
          weergavenaam: 'Middenwetering 1, 3543AR Utrecht',
          gemeente: 'Utrecht',
          provincie: 'Utrecht',
        },
      ],
      vbo: {
        identificatie: '0344010000000001',
        oppervlakte: 500,
        gebruiksdoel: ['kantoorfunctie'],
        pandLinks: ['https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items/0344100000000001'],
        coordinates: [5.12, 52.08],
        status: 'Verblijfsobject in gebruik',
      },
      pand: {
        identificatie: '0344100000000001',
        bouwjaar: 1988,
        status: 'Pand in gebruik',
        aantalVerblijfsobjecten: 1,
      },
    });

    const ep = stubEpOnline([
      {
        Pand_opname_id: 1,
        Energieklasse: 'C',
        Geldig_tot: '2030-01-01T00:00:00Z',
        Opnamedatum: '2020-01-01T00:00:00Z',
        Registratiedatum: '2020-01-02T00:00:00Z',
        Berekeningstype: 'NEN 7120',
        Gebouwklasse: 'Utiliteitsbouw',
        Bouwjaar: 1988,
        Status: 'Bestaand',
        Op_basis_van_referentiegebouw: false,
        EnergieIndex: 1.5,
        Certificaathouder: 'Test Adviseur BV',
      },
    ]);

    const client = await connectClientToServer(bag, ep);

    const response = await client.callTool({
      name: 'get_building_profile',
      arguments: { postcode: '3543AR', huisnummer: 1 },
    });

    expect(response.isError ?? false).toBe(false);
    expect(response.structuredContent).toBeDefined();

    // The output contract is part of the server's public surface; re-check here.
    const parsed = outputSchema.parse(response.structuredContent);
    expect(parsed.matchStatus).toBe('exact');
    expect(parsed.bouwjaar).toBe(1988);
    expect(parsed.energielabel).toBe('C');
    expect(parsed.gemeente).toBe('Utrecht');
    expect(parsed.coordinaten).toEqual({ lat: 52.08, lon: 5.12 });
    expect(parsed.alerts.length).toBeGreaterThan(0);

    await client.close();
  });

  it('returns matchStatus=not_found when BAG has no result', async () => {
    const bag = stubBag({ addresses: [] });
    const ep = stubEpOnline([]);
    const client = await connectClientToServer(bag, ep);

    const response = await client.callTool({
      name: 'get_building_profile',
      arguments: { postcode: '9999ZZ', huisnummer: 999 },
    });

    const parsed = outputSchema.parse(response.structuredContent);
    expect(parsed.matchStatus).toBe('not_found');
    expect(parsed.candidateCount).toBe(0);
    expect(parsed.alerts.some((alert) => alert.includes('Geen adres gevonden'))).toBe(true);
    // Regression: not_found short-circuits before EP-Online, so claiming "no
    // label found in EP-Online" would be a lie. Stay silent about EP here.
    expect(parsed.alerts.some((alert) => alert.includes('Geen geregistreerd energielabel'))).toBe(
      false
    );

    await client.close();
  });
});
