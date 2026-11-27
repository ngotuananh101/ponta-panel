import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSshBanner } from './banner-reader.mjs';

const encoder = new TextEncoder();

function stream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('accepts an SSH 2.0 banner split across chunks after a preamble', async () => {
  assert.equal(await detectSshBanner(stream('notice\r\nSS', 'H-2.0-fixture', '\r\n')), true);
});

test('requires a complete, bounded SSH 2.0 identification line', async () => {
  for (const invalid of ['SSH-2.0-fixture', 'SSH-2.0-\r\n', 'SSH-2.0-fixture\n', 'SSH-1.5-fixture\r\n', `SSH-2.0-${'x'.repeat(250)}\r\n`, 'HTTP/1.1 200 OK\r\n']) {
    assert.equal(await detectSshBanner(stream(invalid)), false);
  }
});

test('stops scanning after the byte budget without accepting a late banner', async () => {
  assert.equal(await detectSshBanner(stream(`${'x'.repeat(4095)}\nSSH-2.0-fixture\r\n`)), false);
});
