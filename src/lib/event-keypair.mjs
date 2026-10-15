/** Shared by event creation and the offline dev-soak importer; never logs keys. */
export async function generateEventKeypair() {
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  ed.hashes.sha512 = sha512;
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKey(privateKey);
  return {
    privateKey: Buffer.from(privateKey).toString('hex'),
    publicKey: Buffer.from(publicKey).toString('hex'),
  };
}
