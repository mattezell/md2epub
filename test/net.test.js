import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, createImageFetcher } from '../src/net.js';

test('address guard: private, loopback, link local and tailnet ranges are blocked', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.101.102.103', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1',
    '::ffff:127.0.0.1', 'not-an-address']) {
    assert.equal(isPrivateAddress(address), true, `${address} should be blocked`);
  }
});

test('address guard: ordinary public addresses are allowed', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700::1']) {
    assert.equal(isPrivateAddress(address), false, `${address} should be allowed`);
  }
});

test('image fetch: a host that resolves to a private address is refused', async () => {
  const fetchImage = createImageFetcher({ fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(() => fetchImage('http://127.0.0.1:8787/secret.png'), /not reachable/);
  await assert.rejects(() => fetchImage('http://[::1]/secret.png'), /not reachable/);
});

test('image fetch: non http schemes are refused', async () => {
  const fetchImage = createImageFetcher({ fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(() => fetchImage('file:///etc/passwd'), /only http and https/);
});

test('image fetch: a redirect into a private address is refused', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
  const fetchImage = createImageFetcher({ fetchImpl });
  await assert.rejects(() => fetchImage('https://example.com/pic.png'), /not reachable/);
});

test('image fetch: a redirect chain that never ends is refused', async () => {
  let hops = 0;
  const fetchImpl = async () => {
    hops += 1;
    return new Response(null, { status: 302, headers: { location: 'https://example.com/again.png' } });
  };
  await assert.rejects(() => createImageFetcher({ fetchImpl, maxRedirects: 2 })('https://example.com/pic.png'), /too many redirects/);
  assert.equal(hops, 3);
});

test('image fetch: oversized responses are refused', async () => {
  const fetchImpl = async () => new Response(new Uint8Array(100), { status: 200, headers: { 'content-type': 'image/png' } });
  await assert.rejects(() => createImageFetcher({ fetchImpl, maxBytes: 10 })('https://example.com/big.png'), /too large/);
});

test('image fetch: a normal image comes back with its declared type', async () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const fetchImpl = async () => new Response(payload, { status: 200, headers: { 'content-type': 'image/png; charset=binary' } });
  const result = await createImageFetcher({ fetchImpl })('https://example.com/pic.png');
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.declaredType, 'image/png');
});
