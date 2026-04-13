# Extending

How to add a second tool without accidentally ruining the design. We'll use a hypothetical `search_addresses` tool (postcode → list of houses in that postcode) as a worked example.

## 1. Decide where the work lives

Three possible homes:

- **Client method** — if you're calling a new upstream endpoint, add a method on the existing `BagClient` or a new client class. Clients own URLs, auth, and response-shape normalization. Nothing else.
- **Domain function** — if the tool does post-processing the agent shouldn't have to do, put the logic in `src/domain/` as a pure function. `generateAlerts` is the canonical example.
- **Tool handler** — wires the pieces together. Defines the Zod schemas and the `description`.

Don't co-locate concerns. If you find yourself writing Zod in a client, or `fetch()` in a domain function, split them.

## 2. Add the client method (if needed)

For `search_addresses`, PDOK Locatieserver already exposes the endpoint, so we extend `BagClient`:

```ts
// src/clients/bag-client.ts
async searchByPostcode(postcode: string): Promise<BagAddress[]> {
  // same pattern as findAddress — just a different query
}
```

Parse the upstream response with Zod so drift throws at the client boundary. Use the client's `timeoutMs` option; don't hard-code timeouts. Let errors throw — the tool handler turns them into `isError` responses.

## 3. Create the tool file

One file per tool in `src/tools/`. Copy the structure from `get-building-profile.ts`:

```ts
// src/tools/search-addresses.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BagClient } from '../clients/bag-client.js';

const description = `\
RETURNS:
List of BAG addresses at the given postcode.

WHEN TO USE:
- User provides only a postcode and needs to pick a specific house.
- Large multi-unit buildings where you need to enumerate the VBOs.

WHEN NOT TO USE:
- You already have postcode + huisnummer — call get_building_profile directly.

QUERY STRATEGY:
- Postcode must be 4 digits + 2 uppercase letters, no space.
- Result is capped at 100 rows; narrower search needed for populous postcodes.`;

const inputSchema = {
  postcode: z.string().regex(/^\d{4}[A-Z]{2}$/).describe('Postcode P6 format, no space'),
};

export const outputSchema = z.object({
  addresses: z.array(
    z.object({
      adres: z.string(),
      huisnummer: z.number(),
      huisletter: z.string().nullable(),
      vbo_id: z.string(),
    })
  ),
  count: z.number(),
});

export function registerSearchAddressesTool(server: McpServer, bagClient: BagClient): void {
  server.registerTool(
    'search_addresses',
    {
      title: 'Zoek adressen op postcode',
      description,
      inputSchema: z.object(inputSchema),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      // fetch, transform, validate, return structuredContent + text fallback
    }
  );
}
```

Every field in both schemas gets a `.describe()`. That's the agent's documentation.

## 4. Register in the factory

```ts
// src/server.ts
import { registerSearchAddressesTool } from './tools/search-addresses.js';

export function createServer(options: CreateServerOptions = {}): McpServer {
  // ...
  registerGetBuildingProfileTool(server, bagClient, epOnlineClient);
  registerSearchAddressesTool(server, bagClient); // ← add here
  return server;
}
```

## 5. Test

Add one file to `test/` following the existing patterns:

- **Alert-like logic?** Pure-function unit test, no mocks.
- **Client behavior?** Stub `globalThis.fetch` with `vi.stubGlobal`, assert response mapping.
- **End-to-end?** Use `InMemoryTransport.createLinkedPair()` with stubbed clients, assert the tool result parses against your `outputSchema`.

Don't write tests that hit the real API. That's what `scripts/smoke.ts` is for.

## 6. Update the server `instructions`

`src/server.ts` passes a top-level `instructions` string to the `McpServer` constructor. Mention new tools there so agents know to reach for them. Keep the style consistent: short, imperative, and honest about limitations.

## Don'ts

- ❌ Don't add authentication — this is a local-run demo server. Put auth in a proxy.
- ❌ Don't add retries inside clients. Failure modes belong in the tool handler (or the agent's retry loop).
- ❌ Don't use a mocking library for small client stubs. Object literals against the `*Like` types are enough.
- ❌ Don't silently paper over upstream drift. Parse upstream JSON with Zod in the client so schema mismatches throw with field-level errors.
- ❌ Don't log to stdout in stdio mode. Use `src/logger.ts`.
