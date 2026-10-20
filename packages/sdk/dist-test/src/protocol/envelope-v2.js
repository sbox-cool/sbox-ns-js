import { base64UrlDecode, base64UrlEncode, utf8 } from "../util/bytes.js";
import { stableJson } from "../util/json.js";
import { aesGcmKey, aesGcmOpen, aesGcmSeal, randomBytes, rsaOaepUnwrap } from "./crypto.js";
import { readField, refuseEnvelope } from "./fields.js";
import { envelopeIdentity, identityKeyOf, validateIdentityBinding } from "./identity.js";
import { assertPayloadSlug, parsePayloadObject, undecryptable, withoutReservedKeys } from "./payload.js";
export const V2_VERSION = "2";
export const V2_ALGORITHM = "rsa-oaep-256+aes-256-gcm";
const RESPONSE_LABEL = "sboxcool.network-storage.encrypted-response.v2";
const MIN_NONCE_LENGTH = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
/**
 * Opens a v2 envelope. Order follows `EncryptedRequestV2.ValidateShape` then `Decrypt`: shape, identity binding,
 * IV/tag/key lengths, RSA-OAEP unwrap, AES-GCM open with the sorted binding as AAD, then payload shape.
 */
export async function openV2Envelope(input) {
    const { raw } = input;
    checkShape(raw, input);
    validateIdentityBinding(raw, input.steamId, input.sessionId);
    const aad = bindingJson(raw);
    const { plaintext, aes } = await decrypt(raw, input.key, aad);
    const decoded = parsePayloadObject(plaintext);
    assertPayloadSlug(decoded, input.endpointSlug);
    return {
        payload: withoutReservedKeys(decoded),
        requestId: readField(decoded, "encryptedRequestId"),
        identityKey: identityKeyOf(raw),
        responseKey: { aes, nonce: readField(raw, "nonce"), keyId: readField(raw, "keyId") },
    };
}
/**
 * Seals a response body for a v2 request. Applied to every body after decryption, errors included. The AAD binds the
 * response to the request nonce and key id so a sealed body cannot be replayed against another request.
 */
export async function sealV2Response(key, body, fixedIv) {
    const iv = fixedIv ?? (await randomBytes(IV_BYTES));
    const aad = utf8(`${RESPONSE_LABEL}\0${key.nonce}\0${key.keyId}`);
    const { ciphertext, tag } = await aesGcmSeal(key.aes, iv, utf8(JSON.stringify(body)), aad);
    return {
        encrypted: true,
        v: 2,
        iv: base64UrlEncode(iv),
        tag: base64UrlEncode(tag),
        payload: base64UrlEncode(ciphertext),
    };
}
function checkShape(raw, input) {
    if (readField(raw, "projectId") !== input.projectId) {
        throw refuseEnvelope("Encrypted request projectId does not match the URL.");
    }
    const slug = readField(raw, "endpointSlug");
    if (slug === "" || input.endpointSlug === "" || slug !== input.endpointSlug) {
        throw refuseEnvelope("Encrypted request endpointSlug is missing or does not match the URL.");
    }
    if (readField(raw, "version") !== V2_VERSION) {
        throw refuseEnvelope("Unsupported encrypted request envelope version.");
    }
    if (readField(raw, "algorithm") !== V2_ALGORITHM) {
        throw refuseEnvelope("Unsupported encrypted request algorithm.");
    }
    if (readField(raw, "nonce").length < MIN_NONCE_LENGTH) {
        throw refuseEnvelope("Encrypted request nonce is missing or too short.");
    }
    const required = ["keyId", "wrappedKey", "iv", "tag", "encryptedPayload"];
    if (required.some((name) => readField(raw, name) === "")) {
        throw refuseEnvelope("Encrypted request envelope is missing keyId, wrappedKey, iv, tag, or encryptedPayload.");
    }
}
/** The canonical binding the AES-GCM tag authenticates. Keys are sorted by `stableJson`. */
function bindingJson(raw) {
    const identity = envelopeIdentity(raw);
    return stableJson({
        version: V2_VERSION,
        algorithm: V2_ALGORITHM,
        projectId: readField(raw, "projectId"),
        identityType: identity.type,
        identity: identity.value,
        nonce: readField(raw, "nonce"),
        keyId: readField(raw, "keyId"),
        endpointSlug: readField(raw, "endpointSlug"),
    });
}
/**
 * Unwraps the AES key and opens the payload. Every failure collapses to the fixed undecryptable refusal, as the
 * server does, so the response does not reveal which step failed.
 */
async function decrypt(raw, key, aad) {
    try {
        const iv = decodeLenient(readField(raw, "iv"));
        const tag = decodeLenient(readField(raw, "tag"));
        const ciphertext = decodeLenient(readField(raw, "encryptedPayload"));
        const wrapped = decodeLenient(readField(raw, "wrappedKey"));
        // An RSA-OAEP block is exactly the modulus size. Reject any other length before the private-key operation.
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0)
            throw new Error("lengths");
        if (wrapped.length !== key.modulusBytes)
            throw new Error("wrapped key length");
        const aesRaw = await rsaOaepUnwrap(key.privateKey, wrapped);
        if (aesRaw.length !== AES_KEY_BYTES)
            throw new Error("aes key length");
        const aes = await aesGcmKey(aesRaw, ["encrypt", "decrypt"]);
        const plaintext = await aesGcmOpen(aes, iv, ciphertext, tag, utf8(aad));
        return { plaintext, aes };
    }
    catch {
        throw undecryptable();
    }
}
/**
 * Lenient base64url, matching the server: both alphabets are accepted and padding is optional. The server maps
 * `-`/`_` to `+`/`/` and calls `Convert.FromBase64String`; this maps the other way and uses the strict decoder.
 */
function decodeLenient(text) {
    return base64UrlDecode(text.replace(/\+/g, "-").replace(/\//g, "_"));
}
