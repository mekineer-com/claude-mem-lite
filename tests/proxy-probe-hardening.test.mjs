// Pre-tag review findings on the v3.73.0 proxy/provider work. All three were
// found by probes the reviewer left on disk, and all three reproduce.
//
//   1. §8 — the proxy URL is printed verbatim in doctor output, so a
//      HTTPS_PROXY carrying userinfo puts the password on the terminal and into
//      `doctor --json`, which is exactly the text users paste into bug reports.
//   2. False green — the reachability probe was a plain TCP connect to the proxy
//      port, so ANYTHING listening there reads as healthy. The check whose whole
//      purpose is to end silent provider failure had a silent failure of its own.
//   3. The timeout argument did not bound total time: the CONNECT phase and the
//      request phase each armed a full-length timer, so a 1000ms budget took
//      2008ms to reject.
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { llmProviderStatus } from '../lib/llm-provider-probe.mjs';
import { onceViaConnectProxy, connectProbeViaProxy, redactProxyUrl } from '../lib/proxy-fetch.mjs';

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

describe('finding 1 — proxy credentials must never reach a user-visible string', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('redactProxyUrl strips userinfo but keeps host and port identifiable', () => {
    expect(redactProxyUrl('http://alice:sup3rs3cret@127.0.0.1:10808')).toBe('http://127.0.0.1:10808');
    expect(redactProxyUrl('http://127.0.0.1:10808')).toBe('http://127.0.0.1:10808');
    // A password-only or user-only form must not leak either.
    expect(redactProxyUrl('http://:hunter2@proxy.corp:3128')).not.toContain('hunter2');
    expect(redactProxyUrl('http://alice@proxy.corp:3128')).not.toContain('alice');
  });

  it('survives an unparseable proxy value without echoing it back', () => {
    // Never return the raw string on the error path — that is how the leak
    // would come back through the "defensive" branch.
    expect(redactProxyUrl('::: not a url :::')).not.toContain('not a url');
    expect(redactProxyUrl(null)).toBeTruthy();
  });

  for (const [label, probe] of [['reachable', async () => ({ reachable: true })],
    ['unreachable', async () => ({ reachable: false, error: 'ECONNREFUSED' })]]) {
    it(`doctor's ${label} message carries no proxy password`, async () => {
      for (const v of PROXY_ENV) vi.stubEnv(v, '');
      vi.stubEnv('HTTPS_PROXY', 'http://alice:sup3rs3cret@127.0.0.1:1');
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('OPENROUTER_API_KEY', 'or-x');
      const s = await llmProviderStatus({ _probe: probe });
      expect(s.message).not.toContain('sup3rs3cret');
      expect(s.message).not.toContain('alice');
      expect(s.message).toContain('127.0.0.1:1');   // still diagnosable
    });
  }

  it('never echoes the API key itself', async () => {
    for (const v of PROXY_ENV) vi.stubEnv(v, '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-secret-key-value');
    const s = await llmProviderStatus({ _probe: async () => ({ reachable: false, error: 'x' }) });
    expect(s.message).not.toContain('or-secret-key-value');
  });
});

describe('finding 2 — a listening socket is not a working proxy', () => {
  let servers = [];
  afterEach(() => { for (const s of servers) s.close(); servers = []; vi.unstubAllEnvs(); });

  function listen(server) {
    servers.push(server);
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  }

  it('connectProbeViaProxy FAILS on a port that accepts TCP but is not a proxy', async () => {
    // A SOCKS-only listener, or a dead proxy whose port something else took.
    const port = await listen(net.createServer((s) => s.end()));
    const r = await connectProbeViaProxy(`http://127.0.0.1:${port}`, 'openrouter.ai', { timeout: 2000 });
    expect(r.reachable).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('connectProbeViaProxy FAILS when the proxy refuses the CONNECT', async () => {
    const server = http.createServer();
    server.on('connect', (req, socket) => { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.end(); });
    const port = await listen(server);
    const r = await connectProbeViaProxy(`http://127.0.0.1:${port}`, 'openrouter.ai', { timeout: 2000 });
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/403/);
  });

  it('connectProbeViaProxy SUCCEEDS when the proxy establishes the tunnel', async () => {
    const server = http.createServer();
    server.on('connect', (req, socket) => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
    const port = await listen(server);
    const r = await connectProbeViaProxy(`http://127.0.0.1:${port}`, 'openrouter.ai', { timeout: 2000 });
    expect(r.reachable).toBe(true);
  });

  it('doctor reports the provider UNREACHABLE through a non-proxy listener (end to end, no seam)', async () => {
    // This is the reviewer's falsegreen.mjs, promoted: before the fix it printed
    // "✓ … reachable" against a socket that cannot carry a single request.
    const port = await listen(net.createServer((s) => s.end()));
    for (const v of PROXY_ENV) vi.stubEnv(v, '');
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${port}`);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-x');
    const s = await llmProviderStatus();
    expect(s.level).toBe('warn');
  });
});

describe('finding 3 — timeout bounds TOTAL time, not each phase', () => {
  let server;
  afterEach(() => { if (server) { server.close(); server = null; } });

  it('rejects within the budget when the proxy establishes the tunnel then goes silent', async () => {
    server = http.createServer();
    // 200 to the CONNECT, then never speaks TLS — the CONNECT timer disarms and
    // the request timer used to start a SECOND full-length countdown.
    server.on('connect', (req, socket) => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
    const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

    const t0 = Date.now();
    await expect(
      onceViaConnectProxy(`http://127.0.0.1:${port}`, 'https://a.test/x', { timeout: 1000 })
    ).rejects.toThrow(/timeout/i);
    const elapsed = Date.now() - t0;
    // Was 2008ms for a 1000ms budget. Allow slack for scheduling, but it must be
    // one budget, not two.
    expect(elapsed).toBeLessThan(1600);
  });
});
