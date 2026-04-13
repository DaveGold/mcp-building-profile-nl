/**
 * MCP server factory — registers tools and returns an McpServer instance.
 *
 * The same factory is used by every transport entrypoint (stdio, HTTP),
 * so tool registration lives in exactly one place.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BagClient } from './clients/bag-client.js';
import { EpOnlineClient } from './clients/ep-online-client.js';
import {
  registerGetBuildingProfileTool,
  type BagClientLike,
  type EpOnlineClientLike,
} from './tools/get-building-profile.js';

const VERSION = '0.1.0';

export interface CreateServerOptions {
  /** Optional injected clients — useful for tests. Production code should omit these. */
  bagClient?: BagClientLike;
  epOnlineClient?: EpOnlineClientLike;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const bagClient = options.bagClient ?? new BagClient();
  const epOnlineClient = options.epOnlineClient ?? new EpOnlineClient();

  const server = new McpServer(
    { name: 'building-profile-nl', version: VERSION },
    {
      instructions:
        'You are connected to the building-profile-nl MCP server.\n\n' +
        'This server exposes Dutch building data from two open government registers:\n' +
        '- BAG (Basisregistratie Adressen en Gebouwen) via PDOK — postcode/huisnummer → ' +
        'bouwjaar, oppervlakte, gebruiksdoel, coordinates.\n' +
        '- EP-Online (RVO) — registered energielabels, EP-1/EP-2, warmtebehoefte, CO₂ emissie.\n\n' +
        'USAGE:\n' +
        '- Call get_building_profile with a Dutch postcode (e.g. "3543AR") and a huisnummer ' +
        '(integer only). Optionally include huisletter and/or toevoeging to disambiguate ' +
        'multi-unit buildings.\n' +
        '- Always read the `alerts` array — it contains bouwjaar-era warnings, Paris Proof ' +
        'threshold breaches, BENG compliance summaries, and (for residential) estimated gas ' +
        'consumption + warmtepomp-geschiktheidsindicatie.\n\n' +
        'LIMITATIONS:\n' +
        '- This server returns a snapshot of public-register data only. It does not provide ' +
        'metered energy consumption, weather data, or building automation data.\n' +
        '- EP-Online coverage is incomplete for older residential buildings — `energielabel: null` ' +
        'does not mean the building has no label, just that none is registered in EP-Online.',
    }
  );

  registerGetBuildingProfileTool(server, bagClient, epOnlineClient);

  return server;
}
