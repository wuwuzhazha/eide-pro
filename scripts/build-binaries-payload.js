#!/usr/bin/env node
'use strict';

/**
 * Builds the eide binaries payloads that are published as assets of the
 * `binaries/<version>` releases of this repository.
 *
 * The payloads are reduced from the upstream eide-resource archives:
 *   - win32: builder/msys/{bin,etc} (bash + tar tool set only), utils/stvp_tools,
 *     include/internal_headers, VERSION
 *   - linux/osx: include/internal_headers, VERSION
 *
 * Usage:
 *   node scripts/build-binaries-payload.js <platform|all> --out <dir> --version <ver>
 *
 * <platform> is one of win32, linux-x86_64, linux-arm64, osx-x86_64, osx-arm64.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const UPSTREAM_BASE = 'https://raw.githubusercontent.com/github0null/eide-resource/master/binaries';

const PLATFORMS = {
    'win32': { upstreamPayload: 'bin-12.1.1.7z' },
    'linux-x86_64': { upstreamPayload: 'bin-12.1.0.7z' },
    'linux-arm64': { upstreamPayload: 'bin-12.1.0.7z' },
    'osx-x86_64': { upstreamPayload: 'bin-12.1.0.7z' },
    'osx-arm64': { upstreamPayload: 'bin-12.1.0.7z' }
};

// internal_headers is identical on every platform, so it is extracted once
// from the smallest upstream payload and reused.
const INTERNAL_HEADERS_SOURCE = 'linux-x86_64';

// The only msys executables/runtime libraries eide still calls:
// ResManager.getUnixBash() (bash) and getUnixTool('tar'), plus the shell
// builtins those scripts use. etc/ must exist or bash silently fails to start.
const MSYS_BIN_FILES = [
    'bash.exe', 'tar.exe',
    'msys-1.0.dll', 'msys-regex-1.dll', 'msys-termcap-0.dll', 'msys-iconv-2.dll', 'msys-intl-8.dll',
    'grep.exe', 'sed.exe', 'awk.exe', 'cat.exe', 'ls.exe', 'rm.exe', 'cp.exe', 'mv.exe',
    'mkdir.exe', 'echo.exe', 'uname.exe', 'chmod.exe'
];

// Compressed size ceilings, so a re-bloated payload fails the build.
const SIZE_LIMITS = {
    'win32': 10 * 1024 * 1024,
    'default': 100 * 1024
};

// Fixed timestamp for every entry, so repeated builds are byte identical.
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

function fail(msg) {
    console.error(`error: ${msg}`);
    process.exit(1);
}

function log(msg) {
    console.log(msg);
}

function get7za() {
    const hostDir = process.platform === 'win32' ? 'win32'
        : process.platform === 'darwin' ? 'darwin'
            : 'linux';
    const exe = process.platform === 'win32' ? '7za.exe' : '7za';
    const p = path.join(REPO_ROOT, 'res', 'tools', hostDir, '7z', exe);
    if (!fs.existsSync(p)) fail(`bundled 7za not found: ${p}`);
    return p;
}

function run7za(args, cwd) {
    return execFileSync(get7za(), args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const request = (currentUrl, redirectsLeft) => {
            https.get(currentUrl, { headers: { 'User-Agent': 'eide-pro-binaries-builder' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) return reject(new Error(`too many redirects: ${url}`));
                    return request(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`download failed (http ${res.statusCode}): ${currentUrl}`));
                }
                const out = fs.createWriteStream(dest);
                res.pipe(out);
                out.on('finish', () => out.close(() => resolve(dest)));
                out.on('error', reject);
                res.on('error', reject);
            }).on('error', reject);
        };
        request(url, 5);
    });
}

function extract(archive, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    run7za(['x', '-y', `-o${destDir}`, archive], undefined);
}

function compress(srcDir, outFile) {
    // -mtc/-mta off and normalized mtimes below make the archive reproducible.
    run7za(['a', '-t7z', '-mx=9', '-mtc=off', '-mta=off', outFile, '.'], srcDir);
}

function writeVersion(dir, version) {
    const verFile = path.join(dir, 'VERSION');
    fs.writeFileSync(verFile, version, 'utf8');
    fs.utimesSync(verFile, FIXED_MTIME, FIXED_MTIME);
}

function normalizeMtimes(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) normalizeMtimes(p);
        fs.utimesSync(p, FIXED_MTIME, FIXED_MTIME);
    }
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(from, to);
        else fs.copyFileSync(from, to);
    }
}

function requireDir(p) {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) fail(`missing directory in upstream payload: ${p}`);
    return p;
}

function buildWin32(upstreamRoot, staging, version) {
    const msysSrc = requireDir(path.join(upstreamRoot, 'builder', 'msys'));
    const msysBinDst = path.join(staging, 'builder', 'msys', 'bin');
    fs.mkdirSync(msysBinDst, { recursive: true });
    for (const name of MSYS_BIN_FILES) {
        const from = path.join(msysSrc, 'bin', name);
        if (!fs.existsSync(from)) fail(`missing msys file in upstream payload: ${from}`);
        fs.copyFileSync(from, path.join(msysBinDst, name));
    }
    copyDir(requireDir(path.join(msysSrc, 'etc')), path.join(staging, 'builder', 'msys', 'etc'));

    copyDir(requireDir(path.join(upstreamRoot, 'utils', 'stvp_tools')), path.join(staging, 'utils', 'stvp_tools'));
    copyDir(requireDir(path.join(upstreamRoot, 'include', 'internal_headers')), path.join(staging, 'include', 'internal_headers'));

    writeVersion(staging, version);
}

function buildMinimal(upstreamRoot, staging, version) {
    copyDir(requireDir(path.join(upstreamRoot, 'include', 'internal_headers')), path.join(staging, 'include', 'internal_headers'));
    writeVersion(staging, version);
}

function assertVersionFile(root, version) {
    const verFile = path.join(root, 'VERSION');
    if (!fs.existsSync(verFile)) fail(`self-check: VERSION missing in ${root}`);
    const cont = fs.readFileSync(verFile, 'utf8').trim();
    if (cont !== version) fail(`self-check: VERSION is '${cont}', expected '${version}'`);
}

function assertWin32Layout(root) {
    const binDir = path.join(root, 'builder', 'msys', 'bin');
    const actual = fs.readdirSync(binDir).sort();
    const expected = MSYS_BIN_FILES.slice().sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(`self-check: msys/bin content mismatch\nexpected: ${expected.join(', ')}\nactual:   ${actual.join(', ')}`);
    }
    for (const p of ['builder/msys/etc/profile', 'utils/stvp_tools', 'include/internal_headers']) {
        if (!fs.existsSync(path.join(root, p))) fail(`self-check: missing ${p}`);
    }
}

function assertMinimalLayout(root) {
    const top = fs.readdirSync(root).sort();
    if (JSON.stringify(top) !== JSON.stringify(['VERSION', 'include'])) {
        fail(`self-check: unexpected top level entries: ${top.join(', ')}`);
    }
    const headers = fs.readdirSync(path.join(root, 'include', 'internal_headers'));
    if (headers.length === 0) fail('self-check: include/internal_headers is empty');
}

function assertBashWorks(root) {
    const bash = path.join(root, 'builder', 'msys', 'bin', 'bash.exe');
    const out = execFileSync(bash, ['-c', 'echo ok && /bin/tar --version'], {
        cwd: path.join(root, 'builder', 'msys'),
        encoding: 'utf8'
    });
    if (!/\bok\b/.test(out) || !/tar/i.test(out)) {
        fail(`self-check: bash/tar smoke test produced unexpected output:\n${out}`);
    }
    return out.trim().split(/\r?\n/).join(' | ');
}

function sizeLimit(platformId) {
    return SIZE_LIMITS[platformId] || SIZE_LIMITS.default;
}

function selfCheck(archive, platformId, version, workDir) {
    const root = path.join(workDir, `selfcheck-${platformId}`);
    extract(archive, root);

    assertVersionFile(root, version);
    if (platformId === 'win32') {
        assertWin32Layout(root);
    } else {
        assertMinimalLayout(root);
    }

    const size = fs.statSync(archive).size;
    const limit = sizeLimit(platformId);
    if (size >= limit) fail(`self-check: ${path.basename(archive)} is ${size} bytes, limit is ${limit} bytes`);

    if (platformId === 'win32') {
        const smoke = assertBashWorks(root);
        log(`  self-check ${platformId}: bash/tar ok -> ${smoke}`);
    }
    log(`  self-check ${platformId}: VERSION=${version}, size=${size} bytes (limit ${limit})`);
}

async function main() {
    const argv = process.argv.slice(2);
    const positional = [];
    let outDir;
    let version;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out') outDir = argv[++i];
        else if (arg === '--version') version = argv[++i];
        else if (arg.startsWith('--out=')) outDir = arg.slice('--out='.length);
        else if (arg.startsWith('--version=')) version = arg.slice('--version='.length);
        else positional.push(arg);
    }

    if (positional.length !== 1) fail('usage: node scripts/build-binaries-payload.js <platform|all> --out <dir> --version <ver>');
    if (!outDir) fail('missing --out <dir>');
    if (!version || !/^\d+(?:\.\d+)+$/.test(version)) fail(`invalid --version: '${version}'`);

    const targetArg = positional[0];
    const targets = targetArg === 'all' ? Object.keys(PLATFORMS) : targetArg.split(',');
    for (const t of targets) {
        if (!PLATFORMS[t]) fail(`unknown platform '${t}', expected one of: ${Object.keys(PLATFORMS).join(', ')}, all`);
    }

    outDir = path.resolve(outDir);
    fs.mkdirSync(outDir, { recursive: true });

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eide-binaries-payload-'));
    const extracted = {};
    const payloadArchives = {};

    const upstreamRoot = async (platformId) => {
        if (extracted[platformId]) return extracted[platformId];
        const payloadName = PLATFORMS[platformId].upstreamPayload;
        if (!payloadArchives[payloadName]) {
            const archive = path.join(workDir, payloadName);
            const url = `${UPSTREAM_BASE}/${platformId}/${payloadName}`;
            log(`downloading ${url}`);
            await download(url, archive);
            payloadArchives[payloadName] = archive;
        }
        const root = path.join(workDir, `upstream-${platformId}`);
        log(`extracting ${PLATFORMS[platformId].upstreamPayload}`);
        extract(payloadArchives[payloadName], root);
        extracted[platformId] = root;
        return root;
    };

    const results = [];

    try {
        for (const platformId of targets) {
            const staging = path.join(workDir, `staging-${platformId}`);
            fs.rmSync(staging, { recursive: true, force: true });
            fs.mkdirSync(staging, { recursive: true });

            log(`[${platformId}] assembling payload`);
            if (platformId === 'win32') {
                buildWin32(await upstreamRoot('win32'), staging, version);
            } else {
                buildMinimal(await upstreamRoot(INTERNAL_HEADERS_SOURCE), staging, version);
            }

            normalizeMtimes(staging);

            const archive = path.join(outDir, `bin-${platformId}.7z`);
            fs.rmSync(archive, { force: true });
            log(`[${platformId}] compressing -> ${archive}`);
            compress(staging, archive);

            selfCheck(archive, platformId, version, workDir);

            results.push({ platformId, archive, size: fs.statSync(archive).size });
        }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }

    log('');
    log('built payloads:');
    for (const r of results) {
        log(`  ${r.platformId.padEnd(14)} ${r.size} bytes  ${r.archive}`);
    }
}

main().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
});
