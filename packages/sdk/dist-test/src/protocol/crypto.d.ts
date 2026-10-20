import type { Bytes } from "../util/bytes.js";
export declare function sha256(data: Bytes): Promise<Bytes>;
export declare function sha256Hex(text: string): Promise<string>;
export declare function hmacSha256(key: Bytes, data: Bytes): Promise<Bytes>;
/** AES-256-GCM key from raw 32-byte material. Keys are created per request, never cached globally. */
export declare function aesGcmKey(raw: Bytes, usages: KeyUsage[]): Promise<CryptoKey>;
/** Decrypts `ciphertext || tag` (the WebCrypto layout) with a separate 16-byte tag. Throws on authentication failure. */
export declare function aesGcmOpen(key: CryptoKey, iv: Bytes, ciphertext: Bytes, tag: Bytes, aad: Bytes): Promise<Bytes>;
export declare function aesGcmSeal(key: CryptoKey, iv: Bytes, plaintext: Bytes, aad: Bytes): Promise<{
    ciphertext: Bytes;
    tag: Bytes;
}>;
/** Standard RSA-OAEP key shape for a loaded request key. The private JWK gives us the public modulus and exponent. */
export interface RsaPublicJwk {
    kty: "RSA";
    n: string;
    e: string;
}
export interface LoadedRequestKey {
    keyId: string;
    /** hex SHA-256 of the SPKI DER of the public half. Clients pin this value. */
    fingerprint: string;
    publicJwk: RsaPublicJwk;
    modulusBytes: number;
    privateKey: CryptoKey;
    createdAt: string;
    retiredAt: string | null;
    graceUntil: string | null;
}
export interface RequestKeyRing {
    currentKeyId: string;
    keys: readonly LoadedRequestKey[];
}
export interface RequestKeyRingFile {
    currentKeyId: string;
    keys: readonly {
        keyId: string;
        createdAt: string;
        retiredAt?: string | null;
        graceUntil?: string | null;
        /** PKCS#8 PEM, RSA 2048 or 3072. Kept in the platform secret store, never in source. */
        privateKeyPem: string;
    }[];
}
/** Imports a PKCS#8 RSA private key. The key is extractable only so its public JWK can be derived. */
export declare function importRsaPrivatePem(pem: string, hash: "SHA-256"): Promise<{
    privateKey: CryptoKey;
    publicJwk: RsaPublicJwk;
    modulusBytes: number;
}>;
/** SubjectPublicKeyInfo DER of an RSA public JWK. The fingerprint and the PEM both derive from it. */
export declare function rsaSpkiDer(publicJwk: RsaPublicJwk): Promise<Bytes>;
export declare function rsaSpkiFingerprint(publicJwk: RsaPublicJwk): Promise<string>;
/** PEM for SPKI DER with 64-character base64 lines, as .NET's `ExportSubjectPublicKeyInfoPem` writes them. */
export declare function spkiPem(der: Bytes): string;
export declare function loadRequestKeyRing(file: RequestKeyRingFile): Promise<RequestKeyRing>;
/** RSA-OAEP(SHA-256) wrap of an AES key for a published request key. Used by clients and tests. */
export declare function rsaOaepWrap(publicJwk: RsaPublicJwk, aesKeyRaw: Bytes): Promise<Bytes>;
export declare function rsaOaepUnwrap(privateKey: CryptoKey, wrapped: Bytes): Promise<Bytes>;
/** RSASSA-PKCS1-v1_5 SHA-256 over `data`, base64url. Used to sign the security config. */
export declare function rsaPkcs1Sign(pem: string, data: Bytes): Promise<string>;
export declare function randomBytes(length: number): Promise<Bytes>;
