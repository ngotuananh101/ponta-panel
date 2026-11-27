const protocol = 'probe.v1';
const { port, grant } = await fetch('/fixture', { cache: 'no-store' }).then(response => response.json());
const relay = `ws://127.0.0.1:${port}/probe`;

function mustReject(offeredGrant) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relay, [protocol, offeredGrant]);
    socket.onopen = () => { socket.close(); reject(new Error('unexpected open')); };
    socket.onclose = () => resolve();
  });
}

function roundTrip() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relay, [protocol, grant]);
    socket.binaryType = 'arraybuffer';
    let verified = false;
    socket.onopen = () => {
      if (socket.protocol !== protocol) {
        socket.close();
        reject(new Error('wrong subprotocol'));
        return;
      }
      socket.send(Uint8Array.of(0, 127, 128, 255));
    };
    socket.onmessage = event => {
      const bytes = event.data instanceof ArrayBuffer ? [...new Uint8Array(event.data)] : [];
      if (bytes.join(',') !== '254,0,19') {
        reject(new Error('wrong response'));
      } else {
        verified = true;
      }
      socket.close(1000);
    };
    socket.onclose = () => verified ? resolve() : reject(new Error('no round trip'));
  });
}

let phase = 'unknown-grant';
try {
  await mustReject('invalid');
  phase = 'round-trip';
  await roundTrip();
  phase = 'retired-grant';
  await mustReject(grant);
  phase = 'pass';
} finally {
  await fetch('/result', { method: 'POST', body: phase });
}
