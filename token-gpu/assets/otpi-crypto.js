// Owner-only OTPI bundle format. One WebCrypto implementation shared by the
// Node build step (dashboard/otpi-owner.cjs) and the browser unlock in app.js.
//
// Same construction as the barryai.cn/research workbench bundle, with its own
// domain-separation strings, so neither passphrase-derived key opens the other:
//   root      = PBKDF2-HMAC-SHA256(passphrase, ROOT_SALT, 600000 rounds, 256 bit)
//   bundleKey = HKDF-SHA256(root, random 16-byte salt per build, BUNDLE_INFO) -> AES-256-GCM
// Bundle bytes = MAGIC + u32 header length + header JSON + AES-GCM ciphertext.
// MAGIC, the length and the header are the AAD: a wrong passphrase, an edited
// header or a flipped ciphertext bit fails authentication and returns nothing.
// This file never stores the passphrase, key bytes or plaintext anywhere.
(function (root) {
  'use strict';

  var MAGIC = 'TGOTPI1\n';
  var VERSION = 1;
  var ROOT_SALT = 'barryai.cn/token-gpu/otpi-owner/root-key/v1';
  var BUNDLE_INFO = 'barryai.cn/token-gpu/otpi-owner/bundle-key/v1';
  var PAYLOAD_SCHEMA = 'barryai.cn/token-gpu/otpi-owner/payload/v1';
  var DEFAULT_ITERATIONS = 600000;
  var MIN_ITERATIONS = 100000;
  var MAX_ITERATIONS = 2000000;
  // Build side only. Bundles stay public (and in the portal mirror's history),
  // so the owner passphrase is the only thing between them and a reader.
  var MIN_PASSPHRASE_LENGTH = 12;
  var MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
  var MAX_HEADER_BYTES = 4096;
  var HEADER_KEYS = ['buildId', 'builtAt', 'cipher', 'compression', 'hkdf', 'kdf', 'v'];
  var PAYLOAD_KEYS = ['archival', 'generated_at_utc', 'otpi', 'schema'];
  var LABS = ['anthropic', 'openai', 'google', 'deepseek'];
  var ARCHIVAL_STATES = ['authorized', 'not_authorized', 'invalid_record', 'owner_private_use'];
  var COLLECTION_STATES = ['ok', 'failed', 'unknown'];
  var DATE = /^\d{4}-\d{2}-\d{2}$/;
  var TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  var COMPUTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

  var encoder = new TextEncoder();

  class BundleAuthError extends Error {
    constructor() {
      super('bundle authentication failed');
      this.name = 'BundleAuthError';
    }
  }

  function subtleOf(subtle) {
    var impl = subtle || (root.crypto && root.crypto.subtle);
    if (!impl) throw new Error('WebCrypto is not available');
    return impl;
  }

  function sameKeys(value, sortedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var own = Object.keys(value).sort();
    return own.length === sortedKeys.length && own.every(function (key, i) { return key === sortedKeys[i]; });
  }

  function bytesToBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(text) {
    if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
      throw new Error('invalid base64');
    }
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function concat(parts) {
    var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var out = new Uint8Array(total);
    var offset = 0;
    parts.forEach(function (part) { out.set(part, offset); offset += part.length; });
    return out;
  }

  function lengthPrefix(length) {
    var out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, length, false);
    return out;
  }

  function randomBytes(length) {
    var bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    return bytes;
  }

  function randomBuildId() {
    return Array.from(randomBytes(8), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // NFC, then JavaScript trim. token_tracker.otpi_owner applies the same rule.
  function normalizePassphrase(raw) {
    var value = String(raw == null ? '' : raw).normalize('NFC').trim();
    if (!value) throw new Error('passphrase is empty');
    return value;
  }

  function checkBuildPassphrase(value) {
    if (Array.from(value).length < MIN_PASSPHRASE_LENGTH) {
      throw new Error('owner passphrase must be at least ' + MIN_PASSPHRASE_LENGTH + ' characters');
    }
    return value;
  }

  function buildHeader(options) {
    return {
      v: VERSION,
      buildId: options.buildId,
      builtAt: options.builtAt,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: options.iterations || DEFAULT_ITERATIONS, salt: ROOT_SALT },
      hkdf: { hash: 'SHA-256', salt: bytesToBase64(options.hkdfSalt), info: BUNDLE_INFO },
      cipher: { name: 'AES-GCM', iv: bytesToBase64(options.iv), tagLength: 128 },
      compression: 'none',
    };
  }

  function validateHeader(header) {
    if (!sameKeys(header, HEADER_KEYS)) throw new Error('unexpected bundle header fields');
    if (header.v !== VERSION) throw new Error('unsupported bundle version');
    if (typeof header.buildId !== 'string' || !/^[0-9a-f]{16}$/.test(header.buildId)) throw new Error('invalid buildId');
    if (typeof header.builtAt !== 'string' || !TIMESTAMP.test(header.builtAt)) throw new Error('invalid builtAt');
    var kdf = header.kdf, hkdf = header.hkdf, cipher = header.cipher;
    if (!sameKeys(kdf, ['hash', 'iterations', 'name', 'salt']) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || kdf.salt !== ROOT_SALT) {
      throw new Error('unsupported KDF');
    }
    if (!Number.isInteger(kdf.iterations) || kdf.iterations < MIN_ITERATIONS || kdf.iterations > MAX_ITERATIONS) {
      throw new Error('KDF iterations out of range');
    }
    if (!sameKeys(hkdf, ['hash', 'info', 'salt']) || hkdf.hash !== 'SHA-256' || hkdf.info !== BUNDLE_INFO || base64ToBytes(hkdf.salt).length !== 16) {
      throw new Error('unsupported HKDF');
    }
    if (!sameKeys(cipher, ['iv', 'name', 'tagLength']) || cipher.name !== 'AES-GCM' || cipher.tagLength !== 128 || base64ToBytes(cipher.iv).length !== 12) {
      throw new Error('unsupported cipher');
    }
    if (header.compression !== 'none') throw new Error('unsupported compression');
    return header;
  }

  function parseBundle(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.byteLength > MAX_BUNDLE_BYTES) throw new Error('bundle exceeds size limit');
    var magic = encoder.encode(MAGIC);
    if (view.length < magic.length + 4) throw new Error('bundle too short');
    for (var i = 0; i < magic.length; i++) {
      if (view[i] !== magic[i]) throw new Error('bundle magic mismatch');
    }
    var length = new DataView(view.buffer, view.byteOffset + magic.length, 4).getUint32(0, false);
    var start = magic.length + 4;
    var end = start + length;
    if (length < 2 || length > MAX_HEADER_BYTES || end + 16 > view.length) throw new Error('bundle header length invalid');
    var header;
    try {
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(view.subarray(start, end)));
    } catch (e) {
      throw new Error('bundle header is not JSON');
    }
    validateHeader(header);
    return { header: header, aad: view.subarray(0, end), ciphertext: view.subarray(end) };
  }

  function checkTimestamp(value, allowEmpty) {
    return (allowEmpty && value === '') || (typeof value === 'string' && TIMESTAMP.test(value));
  }

  // Shape check before anything is rendered. token_tracker.dashboard validates
  // the same block more strictly before encryption.
  function validatePayload(payload) {
    if (!sameKeys(payload, PAYLOAD_KEYS) || payload.schema !== PAYLOAD_SCHEMA) throw new Error('unexpected payload');
    if (!checkTimestamp(payload.generated_at_utc, false)) throw new Error('invalid payload build time');
    if (!sameKeys(payload.archival, ['state']) || ARCHIVAL_STATES.indexOf(payload.archival.state) < 0) {
      throw new Error('invalid archival state');
    }
    var block = payload.otpi;
    if (!block || typeof block !== 'object' || !Array.isArray(block.series)) throw new Error('missing OTPI block');
    if (block.series.map(function (s) { return s && s.key; }).join() !== LABS.join()) throw new Error('unexpected OTPI series');
    block.series.forEach(function (series) {
      if (!Array.isArray(series.observations) || typeof series.label !== 'string') throw new Error('invalid OTPI series');
      var previous = '';
      series.observations.forEach(function (obs) {
        if (!sameKeys(obs, ['date', 'value']) || !DATE.test(obs.date) || obs.date <= previous ||
            typeof obs.value !== 'number' || !isFinite(obs.value) || obs.value <= 0) {
          throw new Error('invalid OTPI observation');
        }
        previous = obs.date;
      });
      var latest = series.latest;
      if (latest !== null && (!sameKeys(latest, ['computed_at', 'date', 'value']) || !DATE.test(latest.date) ||
          typeof latest.value !== 'number' || !COMPUTED_AT.test(latest.computed_at))) {
        throw new Error('invalid OTPI latest point');
      }
    });
    var collection = block.collection;
    if (!sameKeys(collection, ['attempted_at_utc', 'last_success_at_utc', 'status']) ||
        COLLECTION_STATES.indexOf(collection.status) < 0 ||
        !checkTimestamp(collection.attempted_at_utc, true) || !checkTimestamp(collection.last_success_at_utc, true)) {
      throw new Error('invalid OTPI collection status');
    }
    if (!block.freshness || typeof block.freshness.stale !== 'boolean') throw new Error('invalid OTPI freshness');
    return payload;
  }

  async function deriveRootBits(passphrase, kdf, subtle) {
    var impl = subtleOf(subtle);
    var material = await impl.importKey('raw', encoder.encode(normalizePassphrase(passphrase)), 'PBKDF2', false, ['deriveBits']);
    var bits = await impl.deriveBits(
      { name: 'PBKDF2', hash: kdf.hash, salt: encoder.encode(kdf.salt), iterations: kdf.iterations },
      material,
      256
    );
    return new Uint8Array(bits);
  }

  function hkdfParams(hkdf) {
    return { name: 'HKDF', hash: hkdf.hash, salt: base64ToBytes(hkdf.salt), info: encoder.encode(hkdf.info) };
  }

  async function deriveBundleKey(rootBits, hkdf, usages, subtle) {
    var impl = subtleOf(subtle);
    var rootKey = await impl.importKey('raw', rootBits, 'HKDF', false, ['deriveKey']);
    return impl.deriveKey(hkdfParams(hkdf), rootKey, { name: 'AES-GCM', length: 256 }, false, usages);
  }

  // Raw AES key bytes, for the build-side privacy scan cross-check only.
  async function deriveBundleKeyBits(rootBits, hkdf, subtle) {
    var impl = subtleOf(subtle);
    var rootKey = await impl.importKey('raw', rootBits, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await impl.deriveBits(hkdfParams(hkdf), rootKey, 256));
  }

  async function encryptBundle(options) {
    var impl = subtleOf(options.subtle);
    var passphrase = checkBuildPassphrase(normalizePassphrase(options.passphrase));
    var payload = validatePayload(options.payload);
    var header = validateHeader(buildHeader({
      buildId: options.buildId || randomBuildId(),
      builtAt: payload.generated_at_utc,
      iterations: options.iterations,
      hkdfSalt: randomBytes(16),
      iv: randomBytes(12),
    }));
    var headerBytes = encoder.encode(JSON.stringify(header));
    if (headerBytes.length > MAX_HEADER_BYTES) throw new Error('bundle header too large');
    var aad = concat([encoder.encode(MAGIC), lengthPrefix(headerBytes.length), headerBytes]);
    var rootBits = await deriveRootBits(passphrase, header.kdf, impl);
    try {
      var key = await deriveBundleKey(rootBits, header.hkdf, ['encrypt'], impl);
      var ciphertext = new Uint8Array(await impl.encrypt(
        { name: 'AES-GCM', iv: base64ToBytes(header.cipher.iv), additionalData: aad, tagLength: 128 },
        key,
        encoder.encode(JSON.stringify(payload))
      ));
      var bundle = concat([aad, ciphertext]);
      if (bundle.byteLength > MAX_BUNDLE_BYTES) throw new Error('bundle exceeds size limit');
      return bundle;
    } finally {
      rootBits.fill(0);
    }
  }

  async function decryptBundle(bytes, passphrase, subtle) {
    var impl = subtleOf(subtle);
    var parsed = parseBundle(bytes);
    var rootBits = await deriveRootBits(passphrase, parsed.header.kdf, impl);
    var plain;
    try {
      var key = await deriveBundleKey(rootBits, parsed.header.hkdf, ['decrypt'], impl);
      try {
        plain = await impl.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(parsed.header.cipher.iv), additionalData: parsed.aad, tagLength: 128 },
          key,
          parsed.ciphertext
        );
      } catch (e) {
        throw new BundleAuthError();
      }
    } finally {
      rootBits.fill(0);
    }
    var payload;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(plain)));
    } catch (e) {
      throw new Error('bundle payload is not JSON');
    }
    validatePayload(payload);
    if (payload.generated_at_utc !== parsed.header.builtAt) throw new Error('bundle header and payload disagree');
    return { header: parsed.header, payload: payload };
  }

  var api = {
    MAGIC: MAGIC,
    VERSION: VERSION,
    ROOT_SALT: ROOT_SALT,
    BUNDLE_INFO: BUNDLE_INFO,
    PAYLOAD_SCHEMA: PAYLOAD_SCHEMA,
    DEFAULT_ITERATIONS: DEFAULT_ITERATIONS,
    MIN_ITERATIONS: MIN_ITERATIONS,
    MAX_ITERATIONS: MAX_ITERATIONS,
    MIN_PASSPHRASE_LENGTH: MIN_PASSPHRASE_LENGTH,
    MAX_BUNDLE_BYTES: MAX_BUNDLE_BYTES,
    BundleAuthError: BundleAuthError,
    normalizePassphrase: normalizePassphrase,
    checkBuildPassphrase: checkBuildPassphrase,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    buildHeader: buildHeader,
    validateHeader: validateHeader,
    parseBundle: parseBundle,
    validatePayload: validatePayload,
    deriveRootBits: deriveRootBits,
    deriveBundleKeyBits: deriveBundleKeyBits,
    encryptBundle: encryptBundle,
    decryptBundle: decryptBundle,
  };

  root.OtpiCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
