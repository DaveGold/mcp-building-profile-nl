# mcp-building-profile-nl

> **📚 Demonstration / reference implementation.** This repository exists to show what a *rich-domain* MCP server looks like — one that doesn't just proxy an API, but fuses two registers, validates both ends with Zod, and encodes domain knowledge (bouwjaar eras, Paris Proof thresholds, BENG compliance, Nader Voorschrift unit quirks) into a curated `alerts[]` array so the agent can reason without being primed. It's meant to be read, forked, and learned from. It is not a supported product.

An [MCP](https://modelcontextprotocol.io) server that returns a rich building profile for any Dutch address by combining data from two open government registers:

- **BAG** (Basisregistratie Adressen en Gebouwen) via PDOK — `postcode + huisnummer` → bouwjaar, oppervlakte, gebruiksdoel, coordinates
- **EP-Online** (RVO) — registered energielabels, EP-1/EP-2, warmtebehoefte, CO₂, BENG compliance

The server exposes one tool, `get_building_profile`. What makes it worth studying rather than just calling: strict Zod input/output schemas, a long and opinionated tool description, domain post-processing (alerts), and zero infrastructure dependencies beyond Node.

Example session in Claude Code:

> **You:** Is The Edge (Gustav Mahlerlaan 2970, 1081LA Amsterdam) actually as green as it claims?
>
> **Claude:** *calls `get_building_profile`*
> The Edge, Deloitte's 60.362 m² kantoorpand, was built in **2013** and carries a **Label A**. EP-Online lists an EnergieIndex of **0.54** — A-range runs roughly 1.2 and below, so 0.54 is at the very top of the range. CO₂ emissie is **21,26 kg/m²/jaar**, label geldig tot **2030-12-18**. No alerts fired: no Paris Proof breach, no Label C risk, no expired certificate. The sustainability claim holds up against the register data.

## Install

```bash
git clone https://github.com/<you>/mcp-building-profile-nl.git
cd mcp-building-profile-nl
npm install
cp .env.example .env
# edit .env, paste your EP-Online key
npm run build
```

You need Node.js **22 or newer** (for native `fetch` + `AbortSignal.timeout`).

### Getting an EP-Online API key

EP-Online is the RVO's public energy-label register. Register for a free API key at **<https://public.ep-online.nl>** — no approval needed. Drop the key into `.env` as `EP_ONLINE_API_KEY`.

Without a key the server will fail to start. BAG data alone cannot be returned in this server — BAG + EP-Online are presented as a single composite tool on purpose, so agents always see the full picture.

## Run

### Option 1 — MCP Inspector (quickest smoke test)

```bash
npm run inspect
```

This launches the Inspector UI, auto-connects over stdio, and lets you invoke `get_building_profile` with a form.

### Option 2 — Claude Code

A [`.mcp.json`](.mcp.json) is committed at the repo root — you don't need to write one:

```json
{
  "mcpServers": {
    "building-profile-nl": {
      "command": "node",
      "args": ["--env-file=.env", "dist/index.js"]
    }
  }
}
```

It uses Node 22's native `--env-file=.env` flag to load `EP_ONLINE_API_KEY` from your local (gitignored) `.env` — no secrets in the committed config, no absolute paths, no wrapper script.

From a fresh clone:

```bash
npm install
cp .env.example .env    # then paste your EP-Online key into .env
npm run build
```

Then open the project in Claude Code, run `/mcp` and approve `building-profile-nl`. The `get_building_profile` tool appears in the tool list.

### Option 3 — Streamable HTTP (advanced, local-only)

```bash
npm run http
# → POST http://127.0.0.1:3000/mcp
```

⚠️ **No authentication.** Keep this bound to `127.0.0.1`. If you need a remote-reachable server, put an auth proxy in front — don't expose this port directly.

## Try it out

Once `/mcp` shows `building-profile-nl` as connected, paste any of these into Claude Code. They're chosen to exercise different branches of the tool's logic — era alerts, Paris Proof thresholds, BENG compliance, multi-VBO disambiguation:

### A 140-year-old monument with no EP-Online label

> **You:** Wat voor gebouw is het Rijksmuseum (Museumstraat 1, 1071XX Amsterdam)? Wat zou je moeten uitzoeken voor een energierenovatie?

Rijksmuseum's BAG pand is from **1885**, 38.149 m², `bijeenkomstfunctie`, no energielabel in EP-Online. The server will emit the alert *"Pre-Bouwbesluit 1992 — waarschijnlijk beperkte isolatiewaarde"*, which is exactly the era-awareness signal a renovation advisor needs before sizing anything.

### A modern office that misses Paris Proof

> **You:** Is WTC Amsterdam (Gustav Mahlerlaan 10, 1082PP Amsterdam) klaar voor de Paris Proof doelstelling 2040?

1999 kantoor, label **A**, EP-1 van **81,68 kWh/m²**. Sounds fine — until the server flags *"EP-1 boven Paris Proof 2040 richtwaarde (70 kWh/m² voor kantoor)"*. A plain label-A check would have missed it. The `alerts[]` array is how the tool teaches the agent to reason.

### A real portfolio comparison (the money prompt)

> **You:** Ik maak een pitchdeck over de energie-retrofit-opgave in Nederlands commercieel vastgoed. Haal voor mij het gebouwprofiel op van drie iconische Amsterdamse panden:
>
> 1. Het Rijksmuseum — Museumstraat 1, 1071XX
> 2. WTC Amsterdam — Gustav Mahlerlaan 10, 1082PP
> 3. Deloitte's "The Edge" — Gustav Mahlerlaan 2970, 1081LA
>
> Zet per gebouw bouwjaar, energielabel, EnergieIndex, berekeningstype en de belangrijkste alerts in een tabel. Rangschik ze daarna op urgentie voor energetische ingreep en licht de volgorde toe met verwijzing naar Paris Proof 2040 en Label C-plicht.

This is the use case the tool was designed for: three concurrent lookups, cross-building synthesis, and the agent using the domain `alerts[]` — not its own training — to defend its ranking.

## Tool reference

### `get_building_profile`

| Input          | Type                | Required | Example    |
| -------------- | ------------------- | -------- | ---------- |
| `postcode`     | `string` (`4 digits + 2 upper`) | ✅ | `1081LA` |
| `huisnummer`   | `integer > 0`       | ✅       | `2970`     |
| `huisletter`   | `string`            | optional | `A`        |
| `toevoeging`   | `string`            | optional | `bis`      |

Output is a ~40-field object covering:

- **Match metadata** — `matchStatus` (`exact` / `multiple_vbos` / `not_found`), candidate count
- **BAG** — `bouwjaar`, `oppervlakte_m2`, `gebruiksdoel`, `coordinaten`, `vbo_status`, `pand_status`, `aantal_verblijfsobjecten`
- **EP-Online** — `energielabel`, `ep1_energiebehoefte_kwh_m2`, `ep2_fossiel_kwh_m2`, `warmtebehoefte_kwh_m2`, `co2_emissie_kg_m2`, `energie_index`, BENG eisen, EMG forfaitair, `gebouwtype`, `certificaathouder`, ...
- **`alerts[]`** — curated advisory strings (bouwjaar era, Paris Proof breach, BENG pass/fail summary, label expiry, warmtepomp-indicatie, estimated gas consumption for residential)

See [`src/tools/get-building-profile.ts`](src/tools/get-building-profile.ts) for the full Zod output schema with per-field `.describe()` docs.

## Tests

```bash
npm test          # vitest — fast, no network
npm run test:live # live smoke against PDOK + EP-Online (needs API key)
```

The test suite covers the alert rules, label-selection tiebreaking, client fetch behavior (mocked), and an end-to-end tool call over in-memory MCP transports.

## Architecture

```
src/
├── index.ts                     # stdio entrypoint (default)
├── http.ts                      # optional streamable-HTTP entrypoint
├── server.ts                    # createServer() — single factory used by both transports
├── clients/
│   ├── bag-client.ts            # PDOK Locatieserver + BAG OGC v2 (no auth), Zod-validated
│   └── ep-online-client.ts      # EP-Online V5 (API key), Zod-validated
├── tools/
│   └── get-building-profile.ts  # Zod schemas + handler
├── domain/
│   ├── build-profile.ts         # pure mapping: upstream records → BuildingProfile
│   ├── select-best-label.ts     # pick best of N EP-Online labels
│   └── generate-alerts.ts       # post-processing (era, Paris Proof, BENG, heat pump)
└── logger.ts                    # stderr-only structured logger
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning behind each layer, and [docs/EXTENDING.md](docs/EXTENDING.md) for a walkthrough of adding a second tool.

## Why this is a reference implementation

1. **Rich tool description.** The `description` passed to `registerTool` is ~50 lines of structured guidance: `RETURNS`, `WHEN TO USE`, `WHEN NOT TO USE`, `QUERY STRATEGY`, `INTERPRETATION`, `ALERTS`. Agents use this to reason well without any prompt engineering on the caller side.
2. **Zod on both ends.** Input validation stops bad calls at the boundary. Upstream responses from PDOK and EP-Online are parsed with Zod at the client layer — if the wire format drifts, the server fails loudly with field-level errors instead of shipping malformed data to the agent. The tool output type is `z.infer<typeof outputSchema>`, so there's exactly one definition of the profile shape across the codebase.
3. **Domain post-processing belongs in the server.** The `alerts[]` array encodes knowledge that the agent would otherwise need to be primed with: Dutch building-regulation eras, Paris Proof thresholds, Nader Voorschrift unit quirks. Keep that logic with the data.
4. **Single factory, multiple transports.** Both `index.ts` (stdio) and `http.ts` call the same `createServer()`. Tool registration lives in exactly one place.
5. **Stdio logs go to stderr.** Stdio MCP frames use stdout — any stray `console.log` corrupts the protocol. See [src/logger.ts](src/logger.ts).
6. **Hand-rolled test stubs.** No mocking library — tests implement small `BagClientLike` / `EpOnlineClientLike` `Pick<>` types with plain object literals, which reads more clearly than `vi.mock()`.

## Data sources & disclaimer

Data is served directly from the Dutch public registers (Kadaster/PDOK and RVO/EP-Online). This project is **not affiliated with** Kadaster, RVO, or the Dutch government. Data accuracy, completeness, and availability are subject to upstream terms.

## License

MIT — see [LICENSE](LICENSE).
