/********************************************************************************
 * Copyright (C) 2023-2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://CoCreateJS.com/licenses/> or contact us at sales@CoCreateJS.com.

import { security } from '@cocreate/utils';

const tokenExpiration = 30 * 24 * 60; // 30-day token expiration in minutes
const keyPairs = new Map();  // Active public/private cryptographic key pairs
const sessions = new Map();  // In-memory hot session storage cache
let server = null;

/**
 *
 * @public
 * @environment server
 */
function init(serverInstance) {
    server = serverInstance;
    return authenticate;
}

/**
 * Generates a new RSA key pair dynamically and tracks its expiration lifecycle.
 * @returns {Object} Newly created key pair configuration
 * @public
 * @environment server
 */
function createKeyPair() {
    // Utilize security.generateKeyPair utility with RSA configuration
    const { publicKey, privateKey } = security.generateKeyPair('rsa', {
        modulusLength: 2048
    });

    const created = Date.now();
    const keyPair = {
        _id: security.generateApiKey({ prefix: '', byteLength: 16, encoding: 'hex' }).secret,
        privateKey,
        publicKey,
        created,
        // Retain keypairs slightly longer than token expiration to ensure verification window
        expires: created + (tokenExpiration * 2) * 60 * 1000,
    };

    keyPairs.set(keyPair._id, keyPair);
    return keyPair;
}

/**
 * Deletes an expired or revoked RSA key pair from local tracking.
 * @param {Object} keyPair - The target key pair to remove
 * @public
 * @environment server
 */
function deleteKeyPair(keyPair) {
    if (keyPair && keyPair._id) {
        keyPairs.delete(keyPair._id);
    }
}

/**
 * Strips 'Bearer ' prefixes, whitespace, or outer quotes from incoming tokens.
 * @private
 * @environment server
 */
function sanitizeToken(token) {
    if (typeof token !== 'string') return '';
    let cleaned = token.trim();
    if (cleaned.startsWith('Bearer ')) {
        cleaned = cleaned.slice(7).trim();
    }
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1).trim();
    }
    return cleaned;
}

/**
 * Creates and signs a new token utilizing the latest available RSA key pair.
 * Generates an RS256 JWT using security.generateJWT.
 * @public
 * @environment server
 */
function encodeToken(organization_id, user_id, clientId, host) {
    let keyPair = null;
    const currentTime = Date.now();

    // Prune expired keypairs and locate an active signing key
    for (const [key, value] of keyPairs) {
        if (currentTime > value.expires) {
            deleteKeyPair(value);
        } else if (!keyPair) {
            keyPair = value;
        }
    }

    if (!keyPair) {
        keyPair = createKeyPair();
    }

    const iat = Math.floor(currentTime / 1000);
    const exp = iat + (tokenExpiration * 60);

    // Standard JWT Segments
    const header = {
        alg: 'RS256',
        typ: 'JWT',
        kid: keyPair._id
    };

    const payload = {
        user_id,
        clientId,
        organization_id,
        iat,
        exp
    };

    // Offload JWT creation and cryptographic signing to security utility
    const token = security.generateJWT({ header, payload }, keyPair.privateKey, 'RS256');

    const session = {
        user_id,
        clientId,
        token,
        expires: currentTime + tokenExpiration * 60 * 1000
    };

    if (clientId) {
        sessions.set(clientId, session);
    }

    if (server?.crud && clientId) {
        server.crud.send({
            method: 'object.update',
            host,
            array: 'clients',
            object: {
                _id: clientId,
                session,
            },
            upsert: true,
            organization_id
        });
    }

    return token;
}

/**
 * Reads, parses, and validates the configuration and active state of client sessions.
 * @public
 * @environment server
 */
async function read(organization_id, clientId, host) {
    if (!server?.crud || !clientId) return null;

    try {
        const client = await server.crud.send({
            method: 'object.read',
            host,
            array: 'clients',
            object: {
                _id: clientId
            },
            organization_id,
        });

        if (client && client.object) {
            // Support both array response objects and direct document responses
            const target = Array.isArray(client.object) ? client.object[0] : client.object;
            if (target && target.session) {
                sessions.set(clientId, target.session);
                return target.session;
            }
        }
    } catch (err) {
        console.warn('[AUTH] Failed to read session from storage:', err);
    }
    return null;
}

/**
 * Verifies and decodes an incoming session token, resolving the associated user identifier.
 * Incorporates local RSA public-key validation and falls back to self-contained payload data.
 * @public
 * @environment server
 */
async function decodeToken(tokenRaw, organization_id, clientId, host) {
    const token = sanitizeToken(tokenRaw);
    if (!token) return {};

    const parts = token.split('.');
    if (parts.length !== 3) return {};

    const [headerB64, payloadB64] = parts;
    const header = security.base64urlDecode(headerB64);
    const payload = security.base64urlDecode(payloadB64);

    if (!header || !payload) return {};
    const isPlatformOrganization = organization_id === server?.organization_id;
    if (
        organization_id &&
        payload.organization_id !== organization_id &&
        !isPlatformOrganization
    ) {
        return {};
    }

    const currentTime = Date.now();

    // 1. Validate token expiration directly from JWT payload
    if (payload.exp && (payload.exp * 1000) < currentTime) {
        console.warn(`[AUTH] Expired token received for user: ${payload.user_id}`);
        return {};
    }

    // 2. Core Security Check: Identify active signing keys using Key ID (kid) and verify via security engine
    const keyPair = keyPairs.get(header.kid);
    let verifiedPayload;
    if (keyPair) {
        verifiedPayload = security.verifyJWT(token, keyPair.publicKey, 'RS256');
        if (!verifiedPayload) {
            console.warn(`[SECURITY WARNING] Blocked forged token attempt on clientId: ${clientId || payload.clientId}`);
            return {};
        }
    }

    // Determine target clientId from parameters or JWT payload
    const activeClientId = clientId || payload.clientId;

    // 3. Check hot session cache or storage
    let session = activeClientId ? sessions.get(activeClientId) : null;

    if (!session || session.token !== token) {
        if (activeClientId) {
            session = await read(payload?.organization_id || organization_id, activeClientId, host);
        }
    }

    // Active session match found
    if (session && currentTime < session.expires && session.token === token) {
        return { user_id: session.user_id, expires: session.expires };
    }

    // 4. JWT Payload Fallback: Return user_id directly from the decoded payload
    if (verifiedPayload && payload.user_id) {
        return {
            user_id: payload.user_id,
            expires: payload.exp ? (payload.exp * 1000) : (currentTime + tokenExpiration * 60 * 1000)
        };
    }

    if (activeClientId) {
        sessions.delete(activeClientId);

        if (server?.crud) {
            server.crud.send({
                method: 'object.update',
                host,
                array: 'clients',
                object: {
                    _id: activeClientId,
                    session: null
                },
                organization_id: payload?.organization_id || organization_id,
            });
        }
    }

    return {};
}

// Export the API directly as a flat default object manifest
const authenticate = {
    init,
    createKeyPair,
    deleteKeyPair,
    encodeToken,
    decodeToken,
    read
};

export default authenticate;

/**
 * A high-performance, zero-dependency ESM session management and authentication engine using native RS256 asymmetric cryptography, ephemeral 2048-bit RSA keypair rotation, and reactive database state synchronization.
 *
 * @module authenticate
 * @environment server
 */
