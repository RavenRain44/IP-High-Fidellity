// Encrypts OAuth tokens before they are stored, so a database leak alone doesn't expose them.
// Key: TOKEN_ENCRYPTION_KEY secret, 32 random bytes in base64. Format: "v1:" + base64(iv || ciphertext).

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = unb64(base64Key.trim());
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return 'v1:' + b64(out);
}

export async function decrypt(key: CryptoKey, stored: string): Promise<string> {
  if (!stored.startsWith('v1:')) throw new Error('Unknown token format');
  const data = unb64(stored.slice(3));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12));
  return new TextDecoder().decode(plain);
}
