import { readFile } from 'node:fs/promises';

const [reader, worker] = await Promise.all([
  readFile(new URL('./banner-reader.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./banner-worker.mjs', import.meta.url), 'utf8'),
]);
const cloudflareImport = "import { connect } from 'cloudflare:sockets';\n";
const readerImport = "import { detectSshBanner } from './banner-reader.mjs';\n";
const readerExport = 'export async function detectSshBanner(stream) {';
if (!worker.startsWith(cloudflareImport + readerImport) || !reader.includes(readerExport)) {
  throw new Error('Probe module layout changed; update the single-file renderer.');
}
process.stdout.write(
  cloudflareImport + '\n' + reader.replace(readerExport, 'async function detectSshBanner(stream) {') +
  worker.slice(cloudflareImport.length + readerImport.length),
);
