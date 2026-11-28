import { expect, test } from 'bun:test';
import { parsePiModelListing } from '../../../../server-agents/pi/src/agents/pi/pi-models.ts';

// Records the pure listing cases without invoking the discovery process.
test('parses the padded table and diagnoses incomplete output', () => {
  const listing = [
    'Synthetic extension loaded',
    'provider  model                    context  max-out  thinking  images',
    'cloud     accounts/x/model id      200K     32K      yes       no',
    'cloud     scope/model/             200K     32K      yes       no',
    'vision    preview                  1M       16K      no        yes',
  ].join('\r\n');
  expect(parsePiModelListing(listing, '')).toHaveLength(3);
  expect(() => parsePiModelListing(listing.replace('no        yes', 'no        unknown'), '')).toThrow();

  const empty = 'No models available. Use /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md\n  /docs/models.md\n';
  expect(parsePiModelListing(empty, '')).toEqual([]);
  expect(parsePiModelListing('Migration complete\n' + empty, '')).toEqual([]);
  expect(parsePiModelListing(empty, `Warning: ${empty.replaceAll('\n', '\r\n')}`)).toEqual([]);
  expect(() => parsePiModelListing(empty, 'Warning: errors loading models.json')).toThrow();
  expect(() => parsePiModelListing(empty + 'unexpected row', '')).toThrow();
  expect(() => parsePiModelListing('', '')).toThrow();
});
