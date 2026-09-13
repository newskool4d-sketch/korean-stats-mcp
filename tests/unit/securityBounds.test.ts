import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  appendRowsWithinLimit,
  buildCompareStatisticsCacheParams,
  compareStatisticsSchema,
} from '../../src/tools/compareStatistics.js';
import {
  DEFAULT_XLSX_MAX_BYTES,
  readResponseBodyWithLimit,
} from '../../src/tools/fetchKosisExcel.js';
import { assertHttpAuthConfigured } from '../../src/security/httpAuth.js';
import { isJsonRpcBatch } from '../../src/security/httpAdmission.js';
import {
  DEFAULT_KOSIS_JSON_MAX_BYTES,
  DEFAULT_KOSIS_JSON_MAX_ROWS,
  KosisClient,
  readKosisJsonResponseWithLimit,
} from '../../src/api/client.js';
import { CacheManager } from '../../src/cache/index.js';

describe('HTTP authentication configuration', () => {
  it('rejects a network server without a bearer token by default', () => {
    expect(() => assertHttpAuthConfigured('', false)).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('preserves authenticated production and explicit insecure development modes', () => {
    expect(() => assertHttpAuthConfigured('secret', false)).not.toThrow();
    expect(() => assertHttpAuthConfigured('', true)).not.toThrow();
  });
});

describe('HTTP JSON-RPC admission', () => {
  it('rejects JSON-RPC batches while preserving single requests', () => {
    expect(isJsonRpcBatch([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toBe(true);
    expect(isJsonRpcBatch({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
  });
});

describe('compare_statistics request budget', () => {
  const base = {
    orgId: '101',
    tableId: 'DT_TEST',
    compareType: 'period' as const,
    periodType: 'Y' as const,
  };

  it('accepts a legitimate bounded period comparison', () => {
    const result = compareStatisticsSchema.inputSchema.safeParse({
      ...base,
      periods: ['2022', '2023', '2024'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects oversized and duplicate period lists', () => {
    const oversized = Array.from({ length: 13 }, (_, index) => String(2000 + index));
    expect(compareStatisticsSchema.inputSchema.safeParse({ ...base, periods: oversized }).success).toBe(false);
    expect(
      compareStatisticsSchema.inputSchema.safeParse({ ...base, periods: ['2024', '2024'] }).success
    ).toBe(false);
  });

  it('derives cache identity from every effective KOSIS query field', () => {
    const input = { ...base, periods: ['2023', '2024'] };
    const normalized = buildCompareStatisticsCacheParams(input);
    expect(
      buildCompareStatisticsCacheParams({ ...input, objL1: 'ALL', itemId: 'ALL' })
    ).toEqual(normalized);

    for (const changed of [
      { ...input, periodType: 'M' as const },
      { ...input, objL1: '10' },
      { ...input, objL2: '20' },
      { ...input, itemId: 'T1' },
    ]) {
      expect(buildCompareStatisticsCacheParams(changed)).not.toEqual(normalized);
    }
  });

  it('keeps distinct effective queries isolated through the shared cache', async () => {
    const cache = new CacheManager(4);
    const yearly = buildCompareStatisticsCacheParams({
      ...base,
      periods: ['2023', '2024'],
    });
    const monthly = buildCompareStatisticsCacheParams({
      ...base,
      periodType: 'M',
      periods: ['202301', '202302'],
    });
    let calls = 0;
    expect(await cache.getStatisticsData(yearly, async () => (++calls, 'yearly'))).toBe('yearly');
    expect(await cache.getStatisticsData(monthly, async () => (++calls, 'monthly'))).toBe('monthly');
    expect(calls).toBe(2);
  });

  it('rejects a multi-period aggregate before its row budget is exceeded', () => {
    const aggregate = [{ DT: '1' }];

    expect(() => appendRowsWithinLimit(aggregate, [{ DT: '2' }, { DT: '3' }], 2)).toThrow(
      /aggregate row limit/i
    );
    expect(aggregate).toEqual([{ DT: '1' }]);
  });
});

describe('shared cache retained-byte budget', () => {
  it('evicts least-recently-used values before aggregate retained bytes exceed the cap', async () => {
    const cache = new CacheManager(10, 8);
    await cache.getOrFetch('bytes', { key: 'a' }, async () => '123456');
    await cache.getOrFetch('bytes', { key: 'b' }, async () => 'abcdef');

    let refetched = false;
    expect(
      await cache.getOrFetch('bytes', { key: 'a' }, async () => {
        refetched = true;
        return 'new-a';
      })
    ).toBe('new-a');
    expect(refetched).toBe(true);
    expect(cache.getStats().retainedBytes).toBeLessThanOrEqual(8);
  });

  it('returns but does not retain a single value larger than the byte cap', async () => {
    const cache = new CacheManager(10, 4);
    let calls = 0;

    expect(
      await cache.getOrFetch('bytes', { key: 'oversized' }, async () => (++calls, '12345'))
    ).toBe('12345');
    expect(
      await cache.getOrFetch('bytes', { key: 'oversized' }, async () => (++calls, 'fresh'))
    ).toBe('fresh');
    expect(calls).toBe(2);
    expect(cache.getStats().retainedBytes).toBe(0);
  });
});

describe('KOSIS JSON response budget', () => {
  it('closes a real response socket after rejecting an oversized declared body', async () => {
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', '1024');
      res.flushHeaders();
      res.write('[');
      res.socket?.once('close', resolveSocketClosed);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/oversized`);
      await expect(readKosisJsonResponseWithLimit(response, 10, 10)).rejects.toThrow(
        /size limit/i
      );
      const closedBeforeTimeout = await Promise.race([
        socketClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      expect(closedBeforeTimeout).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('cancels a declared oversized body before rejecting it', async () => {
    let cancelled = false;
    const declared = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('['));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-length': '1024' } }
    );

    await expect(readKosisJsonResponseWithLimit(declared, 10, 10)).rejects.toThrow(
      /size limit/i
    );
    expect(cancelled).toBe(true);
  });

  it('accepts bounded JSON and rejects excessive bytes or rows', async () => {
    const bounded = new Response(JSON.stringify([{ value: 1 }]));
    await expect(
      readKosisJsonResponseWithLimit(
        bounded,
        DEFAULT_KOSIS_JSON_MAX_BYTES,
        DEFAULT_KOSIS_JSON_MAX_ROWS
      )
    ).resolves.toEqual([{ value: 1 }]);

    const declared = new Response('[]', {
      headers: { 'content-length': String(DEFAULT_KOSIS_JSON_MAX_BYTES + 1) },
    });
    await expect(
      readKosisJsonResponseWithLimit(
        declared,
        DEFAULT_KOSIS_JSON_MAX_BYTES,
        DEFAULT_KOSIS_JSON_MAX_ROWS
      )
    ).rejects.toThrow(/size limit/i);

    const streamed = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"value":'));
          controller.enqueue(new TextEncoder().encode('123456789}]'));
          controller.close();
        },
      })
    );
    await expect(readKosisJsonResponseWithLimit(streamed, 10, 10)).rejects.toThrow(/size limit/i);

    const tooManyRows = new Response(JSON.stringify([{ value: 1 }, { value: 2 }]));
    await expect(readKosisJsonResponseWithLimit(tooManyRows, 1024, 1)).rejects.toThrow(
      /row limit/i
    );
  });

  it('enforces the byte cap through KosisClient without retrying deterministic oversize', async () => {
    const originalFetch = globalThis.fetch;
    const previousBytes = process.env.KOSIS_JSON_MAX_BYTES;
    const previousRows = process.env.KOSIS_JSON_MAX_ROWS;
    let calls = 0;
    process.env.KOSIS_JSON_MAX_BYTES = '10';
    process.env.KOSIS_JSON_MAX_ROWS = '10';
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('[{"value":'));
            controller.enqueue(new TextEncoder().encode('123456789}]'));
            controller.close();
          },
        })
      );
    };

    try {
      await expect(new KosisClient('test-key').getStatisticsList('MT_ZTITLE')).rejects.toMatchObject({
        code: 'RESPONSE_TOO_LARGE',
      });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBytes === undefined) delete process.env.KOSIS_JSON_MAX_BYTES;
      else process.env.KOSIS_JSON_MAX_BYTES = previousBytes;
      if (previousRows === undefined) delete process.env.KOSIS_JSON_MAX_ROWS;
      else process.env.KOSIS_JSON_MAX_ROWS = previousRows;
    }
  });
});

describe('KOSIS XLSX download budget', () => {
  it('accepts a response within the configured limit', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const result = await readResponseBodyWithLimit(response, 3);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects declared and streamed bodies above the configured limit', async () => {
    const declared = new Response(new Uint8Array([1]), {
      headers: { 'content-length': String(DEFAULT_XLSX_MAX_BYTES + 1) },
    });
    await expect(readResponseBodyWithLimit(declared, DEFAULT_XLSX_MAX_BYTES)).rejects.toThrow(/size limit/i);

    const streamed = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      })
    );
    await expect(readResponseBodyWithLimit(streamed, 3)).rejects.toThrow(/size limit/i);
  });
});

describe('Unix installer interpreter boundary', () => {
  it('pins the remote bridge package in both installers', () => {
    const unixInstaller = readFileSync(new URL('../../install.sh', import.meta.url), 'utf8');
    const windowsInstaller = readFileSync(new URL('../../install.ps1', import.meta.url), 'utf8');
    expect(unixInstaller).toContain('mcp-remote@0.1.38');
    expect(windowsInstaller).toContain('mcp-remote@0.1.38');
    expect(unixInstaller).not.toMatch(/["']mcp-remote["']/);
    expect(windowsInstaller).not.toMatch(/["']mcp-remote["']/);
  });

  it('documents tagged, checksum-verified installer downloads', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('/v1.8.6/install.sh');
    expect(readme).toContain('/v1.8.6/install.ps1');
    expect(readme).toContain('f471fe3e3393495499a2bf883a94ef912495df37d7c7c492fe97be504205812a');
    expect(readme).toContain('bf5e46142ba3ed203f79f6911fcfd6f1dcd4d1a45aa7c1aed8e973b15fb8e55d');
    expect(readme).not.toContain('/main/install.sh');
    expect(readme).not.toContain('/main/install.ps1');
  });

  it('passes shell-controlled values to Python as argv under a quoted heredoc', () => {
    const installer = readFileSync(new URL('../../install.sh', import.meta.url), 'utf8');
    expect(installer).toContain("<<'PY'");
    expect(installer).not.toContain("json.loads('''$config_json''')");
  });

  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const canRunInstaller = process.platform !== 'win32' || existsSync(gitBash);

  it.runIf(canRunInstaller)(
    'keeps quote-bearing URLs inert in the real Python fallback',
    async () => {
      const candidates: Array<[string, string[]]> = [
        ...(process.env.PYTHON ? [[process.env.PYTHON, []] as [string, string[]]] : []),
        ...(process.platform === 'win32' ? [['py', ['-3']] as [string, string[]]] : []),
        ['python3', []],
        ['python', []],
      ];
      const pythonPath = candidates.map(([executable, args]) => spawnSync(
        executable, [...args, '-c', 'import sys; print(sys.executable)'],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
      )).find((result) => result.status === 0 && result.stdout.trim())?.stdout.trim();
      if (!pythonPath) throw new Error('Installer test requires Python 3: set PYTHON to its executable.');
      const root = await mkdtemp(join(tmpdir(), 'korean-stats-install-sh-'));
      const server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end('ok');
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });

      const port = (server.address() as AddressInfo).port;
      const posixHome = process.platform === 'win32'
        ? root.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
        : root;
      const bash = process.platform === 'win32' ? gitBash : 'bash';
      const command = [
        'python3(){ "$TEST_PYTHON" "$@"; }',
        // Force the Python fallback even on hosts with jq installed.
        'command(){ if [[ "$1" == "-v" && "$2" == "jq" ]]; then return 1; fi; builtin command "$@"; }',
        "uname(){ printf 'Linux\\n'; }",
        'export -f python3 uname',
        'source ./install.sh --client claude --url "$TEST_URL"',
      ].join('; ');

      const run = (url: string) => new Promise<number | null>((resolve, reject) => {
        const child = spawn(bash, ['-lc', command], {
          cwd: new URL('../..', import.meta.url),
          env: { ...process.env, HOME: posixHome, TEST_URL: url, TEST_PYTHON: pythonPath.replaceAll('\\', '/') },
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('exit', resolve);
      });

      try {
        expect(await run('http://example.com/stats')).toBe(1);
        expect(await run('http://127.0.0.1:80@evil.example/stats')).toBe(1);
        const craftedUrl = `http://127.0.0.1:${port}/stats/'''`;
        expect(await run(craftedUrl)).toBe(0);
        const configPath = join(root, '.config', 'Claude', 'claude_desktop_config.json');
        const saved = JSON.parse(await readFile(configPath, 'utf8'));
        expect(saved.mcpServers['korean-stats'].args[2]).toBe(craftedUrl);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );
});
