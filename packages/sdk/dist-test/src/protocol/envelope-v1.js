import { constantTimeEqual, decodeV1Bytes, hexEncode, utf8 } from "../util/bytes.js";
import { stableJson } from "../util/json.js";
import { aesGcmKey, aesGcmOpen, hmacSha256, sha256 } from "./crypto.js";
import { ProtocolError } from "./errors.js";
import { readField, refuseEnvelope } from "./fields.js";
import { envelopeIdentity, identityKeyOf, validateIdentityBinding } from "./identity.js";
import { assertPayloadSlug, parsePayloadObject, undecryptable, withoutReservedKeys } from "./payload.js";
export const V1_VERSION = "1";
export const V1_ALGORITHM = "aes-256-gcm+hmac-sha256";
const KEY_LABEL = "sboxcool.network-storage.encrypted-request.v1";
const MIN_NONCE_LENGTH = 8;
const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;
/**
 * Opens a v1 envelope. Order follows `EncryptedEndpointEnvelope.ValidateShape` then `Decrypt`: shape, api-key
 * fingerprint, identity binding, HMAC signature, AES-GCM open, payload shape. Replay consumption is the caller's job
 * and happens only once the endpoint is confirmed.
 */
export async function openV1Envelope(input) {
    const { raw, apiKey } = input;
    const payloadField = readField(raw, "encryptedPayload") || readField(raw, "ciphertext");
    const signature = readField(raw, "signature");
    const iv = readField(raw, "iv");
    const fingerprint = hexEncode(await sha256(utf8(apiKey))).slice(0, 32);
    checkShape(raw, input, fingerprint, payloadField, signature, iv);
    validateIdentityBinding(raw, input.steamId, input.sessionId);
    const context = bindingContext(raw);
    const signatureInput = stableJson({ ...context, iv, encryptedPayload: payloadField, tag: readField(raw, "tag") });
    const expected = hexEncode(await hmacSha256(utf8(apiKey), utf8(signatureInput)));
    if (!constantTimeEqual(utf8(signature.toLowerCase()), utf8(expected))) {
        throw refuseEnvelope("Encrypted request signature does not match the envelope.");
    }
    const plaintext = await decryptPayload(raw, apiKey, context, iv, payloadField);
    const decoded = parsePayloadObject(plaintext);
    assertPayloadSlug(decoded, input.endpointSlug);
    return {
        payload: withoutReservedKeys(decoded),
        requestId: readField(decoded, "encryptedRequestId"),
        identityKey: identityKeyOf(raw),
    };
}
function checkShape(raw, input, fingerprint, payloadField, signature, iv) {
    if (readField(raw, "projectId") !== input.projectId) {
        throw refuseEnvelope("Encrypted request projectId does not match the URL.");
    }
    const slug = readField(raw, "endpointSlug");
    if (slug !== "" && input.endpointSlug !== "" && slug !== input.endpointSlug) {
        throw refuseEnvelope("Encrypted request endpointSlug does not match the URL.");
    }
    if ((readField(raw, "version") || V1_VERSION) !== V1_VERSION) {
        throw refuseEnvelope("Unsupported encrypted request envelope version.");
    }
    if ((readField(raw, "algorithm") || V1_ALGORITHM) !== V1_ALGORITHM) {
        throw refuseEnvelope("Unsupported encrypted request algorithm.");
    }
    if (readField(raw, "nonce").length < MIN_NONCE_LENGTH) {
        throw refuseEnvelope("Encrypted request nonce is missing or too short.");
    }
    if (readField(raw, "publicKeyFingerprint") !== fingerprint) {
        throw refuseEnvelope("Encrypted request public key fingerprint does not match the API key.");
    }
    if (iv === "" || payloadField === "" || signature === "") {
        throw refuseEnvelope("Encrypted request envelope is missing iv, encryptedPayload, or signature.");
    }
}
/** Canonical binding. The AES key and the AAD are both derived from this exact object. */
function bindingContext(raw) {
    const identity = envelopeIdentity(raw);
    const context = {
        version: readField(raw, "version") || V1_VERSION,
        algorithm: readField(raw, "algorithm") || V1_ALGORITHM,
        projectId: readField(raw, "projectId"),
        identityType: identity.type,
        identity: identity.value,
        nonce: readField(raw, "nonce"),
        publicKeyFingerprint: readField(raw, "publicKeyFingerprint"),
    };
    const slug = readField(raw, "endpointSlug");
    if (slug !== "")
        context.endpointSlug = slug;
    return context;
}
async function decryptPayload(raw, apiKey, context, ivText, payloadField) {
    const contextJson = stableJson(context);
    try {
        const iv = decodeV1Bytes(ivText);
        if (iv.length !== GCM_IV_BYTES)
            throw refuseEnvelope("Encrypted request iv must be 12 bytes.");
        const sealed = decodeV1Bytes(payloadField);
        const tagField = readField(raw, "tag");
        const hasTag = tagField !== "";
        const tag = hasTag ? decodeV1Bytes(tagField) : sealed.slice(Math.max(0, sealed.length - GCM_TAG_BYTES));
        const ciphertext = hasTag ? sealed : sealed.slice(0, Math.max(0, sealed.length - GCM_TAG_BYTES));
        if (tag.length !== GCM_TAG_BYTES || ciphertext.length === 0) {
            throw refuseEnvelope("Encrypted request ciphertext or tag is invalid.");
        }
        const keyMaterial = await sha256(utf8(`${KEY_LABEL}\0${apiKey}\0${contextJson}`));
        const key = await aesGcmKey(keyMaterial, ["decrypt"]);
        return await aesGcmOpen(key, iv, ciphertext, tag, utf8(contextJson));
    }
    catch (error) {
        if (error instanceof ProtocolError)
            throw error;
        throw undecryptable();
    }
}
