import { subscribe } from 'node:diagnostics_channel';

// Record verifier error codes at the actual undici connection boundary, without
// request contents, headers, addresses, certificates, or external credentials.
subscribe('undici:client:connectError', ({ error }) => {
  console.error(JSON.stringify({ event: 'native-proof-tls-error', code: error?.code, causeCode: error?.cause?.code }));
});
