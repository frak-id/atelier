export async function generateEd25519Keypair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);

  const [publicKeyRaw, privateKeyRaw] = await Promise.all([
    crypto.subtle.exportKey("raw", keyPair.publicKey),
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  ]);

  const publicKey = formatOpenSshPublicKey(new Uint8Array(publicKeyRaw));
  const privateKey = formatOpenSshPrivateKey(
    new Uint8Array(publicKeyRaw),
    new Uint8Array(privateKeyRaw),
  );

  return { publicKey, privateKey };
}

function formatOpenSshPublicKey(publicKeyRaw: Uint8Array): string {
  const keyType = "ssh-ed25519";
  const keyTypeBytes = new TextEncoder().encode(keyType);

  const blob = new Uint8Array(
    4 + keyTypeBytes.length + 4 + publicKeyRaw.length,
  );
  const view = new DataView(blob.buffer);

  let offset = 0;
  view.setUint32(offset, keyTypeBytes.length, false);
  offset += 4;
  blob.set(keyTypeBytes, offset);
  offset += keyTypeBytes.length;
  view.setUint32(offset, publicKeyRaw.length, false);
  offset += 4;
  blob.set(publicKeyRaw, offset);

  const base64Key = btoa(String.fromCharCode(...blob));
  return `ssh-ed25519 ${base64Key} generated-key`;
}

function formatOpenSshPrivateKey(
  publicKey: Uint8Array,
  privateKeyPkcs8: Uint8Array,
): string {
  const seed = privateKeyPkcs8.slice(-32);
  const authMagic = new TextEncoder().encode("openssh-key-v1\0");
  const cipherName = "none";
  const kdfName = "none";
  const numKeys = 1;

  const keyType = "ssh-ed25519";
  const keyTypeBytes = new TextEncoder().encode(keyType);

  const pubKeyBlob = new Uint8Array(
    4 + keyTypeBytes.length + 4 + publicKey.length,
  );
  let offset = 0;
  new DataView(pubKeyBlob.buffer).setUint32(offset, keyTypeBytes.length, false);
  offset += 4;
  pubKeyBlob.set(keyTypeBytes, offset);
  offset += keyTypeBytes.length;
  new DataView(pubKeyBlob.buffer).setUint32(offset, publicKey.length, false);
  offset += 4;
  pubKeyBlob.set(publicKey, offset);

  const checkInt = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const comment = "generated-key";
  const commentBytes = new TextEncoder().encode(comment);

  const fullPrivateKey = new Uint8Array(64);
  fullPrivateKey.set(seed, 0);
  fullPrivateKey.set(publicKey, 32);

  const privateSectionBase =
    4 +
    4 +
    4 +
    keyTypeBytes.length +
    4 +
    publicKey.length +
    4 +
    fullPrivateKey.length +
    4 +
    commentBytes.length;

  const padding = (8 - (privateSectionBase % 8)) % 8;
  const privateSection = new Uint8Array(privateSectionBase + padding);

  offset = 0;
  const privView = new DataView(privateSection.buffer);
  privView.setUint32(offset, checkInt, false);
  offset += 4;
  privView.setUint32(offset, checkInt, false);
  offset += 4;
  privView.setUint32(offset, keyTypeBytes.length, false);
  offset += 4;
  privateSection.set(keyTypeBytes, offset);
  offset += keyTypeBytes.length;
  privView.setUint32(offset, publicKey.length, false);
  offset += 4;
  privateSection.set(publicKey, offset);
  offset += publicKey.length;
  privView.setUint32(offset, fullPrivateKey.length, false);
  offset += 4;
  privateSection.set(fullPrivateKey, offset);
  offset += fullPrivateKey.length;
  privView.setUint32(offset, commentBytes.length, false);
  offset += 4;
  privateSection.set(commentBytes, offset);
  offset += commentBytes.length;

  for (let i = 0; i < padding; i++) {
    privateSection[offset + i] = i + 1;
  }

  const cipherBytes = new TextEncoder().encode(cipherName);
  const kdfBytes = new TextEncoder().encode(kdfName);

  const totalSize =
    authMagic.length +
    4 +
    cipherBytes.length +
    4 +
    kdfBytes.length +
    4 +
    4 +
    4 +
    pubKeyBlob.length +
    4 +
    privateSection.length;

  const fullKey = new Uint8Array(totalSize);
  const fullView = new DataView(fullKey.buffer);
  offset = 0;

  fullKey.set(authMagic, offset);
  offset += authMagic.length;
  fullView.setUint32(offset, cipherBytes.length, false);
  offset += 4;
  fullKey.set(cipherBytes, offset);
  offset += cipherBytes.length;
  fullView.setUint32(offset, kdfBytes.length, false);
  offset += 4;
  fullKey.set(kdfBytes, offset);
  offset += kdfBytes.length;
  fullView.setUint32(offset, 0, false);
  offset += 4;
  fullView.setUint32(offset, numKeys, false);
  offset += 4;
  fullView.setUint32(offset, pubKeyBlob.length, false);
  offset += 4;
  fullKey.set(pubKeyBlob, offset);
  offset += pubKeyBlob.length;
  fullView.setUint32(offset, privateSection.length, false);
  offset += 4;
  fullKey.set(privateSection, offset);

  const base64 = btoa(String.fromCharCode(...fullKey));
  const lines = base64.match(/.{1,70}/g) || [];

  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...lines,
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
}

export async function isWebCryptoEd25519Supported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ]);
    return true;
  } catch {
    return false;
  }
}
