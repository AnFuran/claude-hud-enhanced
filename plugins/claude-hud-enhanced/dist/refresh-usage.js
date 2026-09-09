import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { getClaudeConfigDir } from './claude-config-dir.js';
import { BACKOFF_AUTH_MS, BACKOFF_ERROR_MS, BACKOFF_RATE_LIMIT_MS, shouldRefresh, } from './usage-hybrid.js';
import { getLockPath, getSnapshotPath, readSnapshot, writeSnapshotAtomic, } from './usage-snapshot.js';
import { getClaudeCodeVersion } from './version.js';
/**
 * Detached OAuth usage refresher (see docs/oauth-usage-poll-handoff.md).
 *
 * Spawned by the HUD (which holds the single-flight lock) when the shared
 * usage snapshot goes stale while idle. Reads the Claude Code OAuth token
 * READ-ONLY (never writes refreshed tokens back — that races Claude Code's own
 * store), asks the token's issuer for the account-wide usage, and persists it
 * via the same atomic snapshot writer the HUD uses. Token-read + endpoint
 * shape ported from sirmalloc/ccstatusline (src/utils/usage-fetch.ts).
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/**
 * Proxy for the usage call when no HTTPS_PROXY/HTTP_PROXY is set. Node's global
 * fetch ignores those variables, so the refresher tunnels through the proxy by
 * hand (see getViaProxy); set NO_PROXY=api.anthropic.com to go direct instead.
 */
const DEFAULT_PROXY_URL = 'http://127.0.0.1:7890';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const FETCH_TIMEOUT_MS = 5_000;
const WATCHDOG_MS = 15_000;
/** Extract `claudeAiOauth.accessToken` from a credentials JSON blob. */
export function parseAccessToken(rawJson) {
    try {
        const parsed = JSON.parse(rawJson);
        const token = parsed?.claudeAiOauth?.accessToken;
        return typeof token === 'string' && token.length > 0 ? token : null;
    }
    catch {
        return null;
    }
}
/**
 * Claude Code stores the default profile's token under the bare service name
 * and each custom CLAUDE_CONFIG_DIR profile under a suffixed service:
 * `Claude Code-credentials-<sha256(configDir)[:8]>` (verified against a live
 * multi-profile Keychain). Selecting the profile's own service — and NEVER
 * falling back to the bare (default-account) entry for a custom profile — is
 * what keeps profiles from silently mixing accounts in the usage snapshot.
 */
export function keychainServiceForConfigDir(configDir, homeDir) {
    const defaultDir = path.join(homeDir, '.claude');
    if (path.resolve(configDir) === path.resolve(defaultDir)) {
        return KEYCHAIN_SERVICE;
    }
    const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return `${KEYCHAIN_SERVICE}-${suffix}`;
}
function readKeychainToken(service) {
    try {
        const secret = execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: FETCH_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }).trim();
        return secret ? parseAccessToken(secret) : null;
    }
    catch {
        return null;
    }
}
function readCredentialsFileToken(configDir) {
    try {
        return parseAccessToken(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
    }
    catch {
        return null;
    }
}
/**
 * Read the OAuth token for THIS profile: macOS Keychain (profile-specific
 * service) first, credentials file otherwise. A custom profile intentionally
 * has no bare-service fallback — serving the default account's token to a
 * work profile would be worse than serving nothing.
 */
export function readOauthToken(configDir, homeDir = os.homedir()) {
    if (process.platform === 'darwin') {
        const service = keychainServiceForConfigDir(configDir, homeDir);
        return readKeychainToken(service) ?? readCredentialsFileToken(configDir);
    }
    return readCredentialsFileToken(configDir);
}
/**
 * One API bucket → snapshot window. A `null` bucket (Enterprise accounts have
 * no rate-limit windows) parses to 0% with no reset, matching ccstatusline.
 */
function parseWindow(v) {
    if (v === null)
        return { used_percentage: 0, resets_at: null };
    if (typeof v !== 'object' || v === undefined)
        return undefined;
    const w = v;
    return {
        used_percentage: typeof w.utilization === 'number' ? w.utilization : null,
        resets_at: typeof w.resets_at === 'string' ? w.resets_at : null,
    };
}
/** Parse the usage API body; null when it carries no usable window at all. */
export function parseUsageResponse(body) {
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const five = parseWindow(parsed.five_hour);
        const seven = parseWindow(parsed.seven_day);
        if (five === undefined && seven === undefined)
            return null;
        return {
            five_hour: five ?? { used_percentage: null, resets_at: null },
            seven_day: seven ?? { used_percentage: null, resets_at: null },
        };
    }
    catch {
        return null;
    }
}
/** `Retry-After` header (delta-seconds or HTTP-date) → milliseconds, null if unusable. */
export function parseRetryAfterMs(headerValue, nowMs) {
    const v = headerValue?.trim();
    if (!v)
        return null;
    if (/^\d+$/.test(v)) {
        const seconds = Number.parseInt(v, 10);
        return seconds > 0 ? seconds * 1000 : null;
    }
    const retryAtMs = Date.parse(v);
    if (!Number.isFinite(retryAtMs))
        return null;
    const ms = retryAtMs - nowMs;
    return ms > 0 ? ms : null;
}
export function successSnapshot(windows, now) {
    const at = new Date(now).toISOString();
    return {
        updated_at: at,
        // A real LIVE read just landed — the one place this clock may move.
        oauth_updated_at: at,
        source: 'oauth',
        ...windows,
        status: 'ok',
        next_attempt_at: null,
    };
}
/**
 * Failed attempt → snapshot that PRESERVES the last-good values and moves neither
 * clock (`updated_at`, `oauth_updated_at`), only sets the retry backoff. A poll
 * that failed is not a read, and must not be recorded as one.
 */
export function failureSnapshot(prev, status, now, retryAfterMs = null) {
    const backoffMs = status === 'auth_expired' ? BACKOFF_AUTH_MS
        : status === 'rate_limited' ? (retryAfterMs ?? BACKOFF_RATE_LIMIT_MS)
            : BACKOFF_ERROR_MS;
    return {
        updated_at: prev?.updated_at ?? new Date(0).toISOString(),
        oauth_updated_at: prev?.oauth_updated_at ?? null,
        source: prev?.source ?? 'oauth',
        five_hour: prev?.five_hour ?? { used_percentage: null, resets_at: null },
        seven_day: prev?.seven_day ?? { used_percentage: null, resets_at: null },
        status,
        next_attempt_at: new Date(now + backoffMs).toISOString(),
    };
}
function firstNonEmpty(...values) {
    return values.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
}
/** Standard NO_PROXY semantics: `*`, an exact host, or a domain suffix (`.example.com` / `example.com`). */
function noProxyMatches(noProxy, host) {
    if (!noProxy)
        return false;
    const target = host.toLowerCase();
    return noProxy
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
        .some((entry) => {
        if (entry === '*')
            return true;
        const suffix = entry.startsWith('.') ? entry : `.${entry}`;
        return target === entry || target.endsWith(suffix);
    });
}
/**
 * Proxy to tunnel the usage call through: HTTPS_PROXY > https_proxy > HTTP_PROXY
 * > http_proxy, else DEFAULT_PROXY_URL. Null means "connect directly" — the host
 * is covered by NO_PROXY, or the configured value is not an http(s) URL.
 */
export function resolveProxyUrl(host, env = process.env) {
    if (noProxyMatches(firstNonEmpty(env.NO_PROXY, env.no_proxy), host))
        return null;
    const raw = firstNonEmpty(env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy) ?? DEFAULT_PROXY_URL;
    try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    }
    catch {
        return null;
    }
}
/**
 * GET `url` through an HTTP CONNECT tunnel on `proxy` with node:http + node:tls —
 * no undici dependency, works on every supported Node. Rejects on proxy, TLS, or
 * network failure and after `timeoutMs` of socket inactivity.
 */
function getViaProxy(url, proxy, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const targetPort = Number(url.port) || 443;
        const target = `${url.hostname}:${targetPort}`;
        const proxyHeaders = { Host: target };
        if (proxy.username) {
            const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
            proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
        }
        const connectVia = proxy.protocol === 'https:' ? https.request : http.request;
        const connect = connectVia({
            host: proxy.hostname.replace(/^\[|\]$/g, ''),
            port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
            method: 'CONNECT',
            path: target,
            headers: proxyHeaders,
            timeout: timeoutMs,
        });
        connect.once('timeout', () => connect.destroy(new Error('proxy CONNECT timed out')));
        connect.once('error', reject);
        connect.once('connect', (connectRes, socket, head) => {
            if (connectRes.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`proxy CONNECT failed: ${connectRes.statusCode}`));
                return;
            }
            if (head.length > 0)
                socket.unshift(head);
            const req = https.request({
                host: url.hostname,
                port: targetPort,
                method: 'GET',
                path: `${url.pathname}${url.search}`,
                headers,
                timeout: timeoutMs,
                // Run TLS over the tunnel socket; SNI and the certificate check still
                // target the real host, so the proxy cannot impersonate it.
                createConnection: () => tls.connect({ socket, host: url.hostname, servername: url.hostname }),
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.once('error', reject);
                res.once('end', () => {
                    const retryAfter = res.headers['retry-after'];
                    resolve({
                        status: res.statusCode ?? 0,
                        retryAfter: typeof retryAfter === 'string' ? retryAfter : null,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            });
            req.once('timeout', () => req.destroy(new Error('usage request timed out')));
            req.once('error', reject);
            req.end();
        });
        connect.end();
    });
}
/** Direct path (host excluded by NO_PROXY): plain fetch, as before. */
async function getDirect(url, headers, timeoutMs) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return {
        status: res.status,
        retryAfter: res.headers.get('retry-after'),
        body: await res.text().catch(() => ''),
    };
}
async function fetchUsage(token, userAgent, now) {
    const url = new URL(USAGE_URL);
    const headers = {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': userAgent,
    };
    let res;
    try {
        const proxy = resolveProxyUrl(url.hostname);
        res = proxy
            ? await getViaProxy(url, proxy, headers, FETCH_TIMEOUT_MS)
            : await getDirect(url, headers, FETCH_TIMEOUT_MS);
    }
    catch {
        return { kind: 'error' };
    }
    if (res.status === 401 || res.status === 403)
        return { kind: 'auth_expired' };
    if (res.status === 429) {
        return { kind: 'rate_limited', retryAfterMs: parseRetryAfterMs(res.retryAfter, now) };
    }
    if (res.status < 200 || res.status >= 300)
        return { kind: 'error' };
    const windows = parseUsageResponse(res.body);
    return windows ? { kind: 'ok', windows } : { kind: 'error' };
}
async function main() {
    const homeDir = os.homedir();
    const snapshotPath = getSnapshotPath(homeDir);
    const prev = readSnapshot(snapshotPath);
    const now = Date.now();
    // Double-check freshness: another writer (a second terminal's refresher, or
    // an active session's stdin) may have refreshed between spawn and now. This is
    // deliberately the SAME predicate the parent spawned on — a child that bailed on
    // a condition the parent ignores would be respawned every render.
    if (prev && !shouldRefresh(prev, now))
        return;
    const token = readOauthToken(getClaudeConfigDir(homeDir));
    if (!token) {
        writeSnapshotAtomic(snapshotPath, failureSnapshot(prev, 'auth_expired', now), now);
        return;
    }
    const version = await getClaudeCodeVersion().catch(() => undefined);
    const outcome = await fetchUsage(token, `claude-code/${version ?? 'unknown'}`, now);
    const done = Date.now();
    const snapshot = outcome.kind === 'ok'
        ? successSnapshot(outcome.windows, done)
        : failureSnapshot(prev, outcome.kind, done, outcome.kind === 'rate_limited' ? outcome.retryAfterMs : null);
    writeSnapshotAtomic(snapshotPath, snapshot, done);
}
function removeLock(lockPath) {
    try {
        fs.rmSync(lockPath, { force: true });
    }
    catch {
        /* best effort */
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const lockPath = getLockPath(os.homedir());
    // Watchdog: if anything wedges (keychain prompt, hung socket), release the
    // lock and die rather than linger. unref'd so a clean run exits naturally.
    const watchdog = setTimeout(() => {
        removeLock(lockPath);
        process.exit(1);
    }, WATCHDOG_MS);
    watchdog.unref();
    void main()
        .catch(() => {
        /* silent — detached child has nowhere to report */
    })
        .finally(() => {
        clearTimeout(watchdog);
        removeLock(lockPath); // always release the parent-taken single-flight lock
    });
}
//# sourceMappingURL=refresh-usage.js.map