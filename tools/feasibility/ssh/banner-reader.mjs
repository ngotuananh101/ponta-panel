const MAX_BYTES = 4096;
const MAX_BANNER_LENGTH = 255;

export async function detectSshBanner(stream) {
  const reader = stream.getReader();
  let line = '';
  let total = 0;
  try {
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) return false;
      for (const byte of value) {
        if (++total > MAX_BYTES) return false;
        if (byte === 10) {
          if (line.startsWith('SSH-')) {
            return line.length + 1 <= MAX_BANNER_LENGTH && /^SSH-2\.0-[!-~]+(?: [ -~]*)?\r$/.test(line);
          }
          line = '';
        } else {
          line += String.fromCharCode(byte);
        }
      }
    }
    return false;
  } finally {
    reader.releaseLock();
  }
}
