const {
    parseSha256ChecksumFile,
    sha256HexOf,
    verifyFileSha256
} = require('../../../src/mcp/tooling_install') as any;

function assert(condition: boolean, message: string): void {
    if (!condition) {
        console.error('FAIL:', message);
        process.exit(1);
    }
    console.log('OK:', message);
}

const payload = Buffer.from('fake tarball bytes for the checksum test');
const digest = sha256HexOf(payload);
assert(/^[0-9a-f]{64}$/.test(digest), 'sha256: digest is lowercase hex of 64 chars');

const sha256sumFormat = `${digest}  eide-pro-headless-4.3.1.tgz\n`;
assert(
    parseSha256ChecksumFile(sha256sumFormat, 'eide-pro-headless-4.3.1.tgz') === digest,
    'parse: sha256sum two-space format resolves by file name'
);
assert(
    parseSha256ChecksumFile(`${digest} *eide-pro-headless-4.3.1.tgz\n`, 'eide-pro-headless-4.3.1.tgz') === digest,
    'parse: binary marker star is accepted'
);
assert(
    parseSha256ChecksumFile(`${digest}\n`, 'ignored-name') === digest,
    'parse: bare digest line is accepted'
);
assert(
    parseSha256ChecksumFile(sha256sumFormat, 'eide-pro-headless-9.9.9.tgz') === undefined,
    'parse: a digest for a different file name does not match'
);
assert(
    parseSha256ChecksumFile('not a checksum at all', 'x.tgz') === undefined,
    'parse: garbage yields undefined'
);
assert(
    parseSha256ChecksumFile('', 'x.tgz') === undefined,
    'parse: empty file yields undefined'
);

const upperDigest = digest.toUpperCase();
assert(
    parseSha256ChecksumFile(`${upperDigest}  x.tgz`, 'x.tgz') === digest,
    'parse: uppercase digests normalize to lowercase'
);

assert(
    verifyFileSha256(payload, sha256sumFormat, 'eide-pro-headless-4.3.1.tgz').status === 'match',
    'verify: matching payload reports match'
);
const mismatch = verifyFileSha256(Buffer.from('corrupted bytes'), sha256sumFormat, 'eide-pro-headless-4.3.1.tgz');
assert(
    mismatch.status === 'mismatch' && mismatch.expected === digest && mismatch.actual !== digest,
    'verify: corrupted payload reports mismatch with both digests'
);
assert(
    verifyFileSha256(payload, 'garbage', 'eide-pro-headless-4.3.1.tgz').status === 'unparseable',
    'verify: unparseable checksum file is reported, not silently passed'
);

// counterproof: flipping one bit in the payload must turn match into mismatch.
const tampered = Buffer.from(payload);
tampered[0] = tampered[0] ^ 0xff;
assert(
    verifyFileSha256(tampered, sha256sumFormat, 'eide-pro-headless-4.3.1.tgz').status === 'mismatch',
    'counterproof: one flipped bit breaks the verification'
);

console.log('All tooling checksum tests passed.');

export {};
