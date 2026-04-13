/**
 * Live smoke test — hits the real PDOK and EP-Online APIs.
 *
 * Usage:
 *   EP_ONLINE_API_KEY=... npm run test:live
 *   EP_ONLINE_API_KEY=... tsx scripts/smoke.ts 1012JS 1
 *
 * Requires a real API key. NOT part of the `npm test` suite.
 */

import { BagClient } from '../src/clients/bag-client.js';
import { EpOnlineClient } from '../src/clients/ep-online-client.js';
import { selectBestLabel } from '../src/domain/select-best-label.js';
import { generateAlerts } from '../src/domain/generate-alerts.js';
import { buildProfile } from '../src/domain/build-profile.js';

async function main(): Promise<void> {
  const [postcode = '3543AR', huisnummerArg = '1'] = process.argv.slice(2);
  const huisnummer = Number(huisnummerArg);

  if (!/^\d{4}[A-Z]{2}$/.test(postcode) || !Number.isInteger(huisnummer)) {
    console.error('Usage: tsx scripts/smoke.ts <postcode> <huisnummer>');
    console.error('Example: tsx scripts/smoke.ts 3543AR 1');
    process.exit(2);
  }

  const bag = new BagClient();
  const ep = new EpOnlineClient();

  console.log(`→ findAddress ${postcode} ${huisnummer}`);
  const addresses = await bag.findAddress(postcode, huisnummer);
  console.log(`  got ${addresses.length} candidate(s)`);
  if (addresses.length === 0) {
    console.log('  no match — stopping.');
    return;
  }

  const best = addresses[0];
  const [vbo, labels] = await Promise.all([
    bag.getVerblijfsobject(best.vboId),
    ep.getByBagVboId(best.vboId),
  ]);
  const pand = vbo && vbo.pandLinks.length > 0 ? await bag.getPand(vbo.pandLinks[0]) : null;

  const profile = buildProfile({
    matchStatus: addresses.length === 1 ? 'exact' : 'multiple_vbos',
    candidateCount: addresses.length,
    labelCount: labels.length,
    address: best,
    vbo,
    pand,
    label: selectBestLabel(labels),
  });

  const alerts = generateAlerts(profile);

  console.log('\n--- Profile ---');
  console.log(JSON.stringify({ ...profile, alerts }, null, 2));
}

main().catch((error) => {
  console.error('smoke failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
