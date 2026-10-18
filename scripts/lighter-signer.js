#!/usr/bin/env node
/**
 * Install or verify the Lighter native signer.
 *
 * The signer is the Go shared library that ships inside elliottech/lighter-python. It is downloaded
 * from one pinned commit and must match the pinned sha256 before it is written to
 * vendor/lighter-signer/ (gitignored). The bot checks the same hash again before loading it
 * (src/lib/exchange/lighter/signer.ts).
 *
 * Usage:
 *   npm run lighter:signer                  install the signer for this platform (no-op when valid)
 *   npm run lighter:signer -- --verify      check the installed file only; never uses the network
 *
 * Options:
 *   --platform <key>   linux-x64, linux-arm64, darwin-arm64, darwin-x64 or win32-x64 (default: this machine)
 *   --dir <path>       install directory (default: vendor/lighter-signer in the project root)
 *
 * Downloads go through HTTPS_PROXY (http:// proxies only) when it is set and the host is not in NO_PROXY.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const tls = require('tls');

// Keep in sync with src/lib/exchange/lighter/signer.ts (tests/lib/lighter/signer.test.ts checks this)
const LIGHTER_SIGNER_COMMIT = '5825eb19867a4dbdd47c02642dc1eec30c30ca73';
const LIGHTER_SIGNER_BASE_URL =
  `https://raw.githubusercontent.com/elliottech/lighter-python/${LIGHTER_SIGNER_COMMIT}/lighter/signers/`;
const LIGHTER_SIGNER_BINARIES = Object.freeze({
  'linux-x64': Object.freeze({ file: 'lighter-signer-linux-amd64.so', sha256: '49c6b61e0e95a4a70f2a252e469c393760c929d61179c340e2932ab62882caf2' }),
  'linux-arm64': Object.freeze({ file: 'lighter-signer-linux-arm64.so', sha256: '3b6fd0b8f4caecbff9ce817dffb11a2321f078e0b4acc9a58623354bb55cc289' }),
  'darwin-arm64': Object.freeze({ file: 'lighter-signer-darwin-arm64.dylib', sha256: 'b8e602542721a11aff4236a247e775150b421c0eb7532442209658a5b0c22f31' }),
  'darwin-x64': Object.freeze({ file: 'lighter-signer-darwin-amd64.dylib', sha256: 'a74e230cebde6c61d35de09587f0980b383b991fa694f974b4070adec6b64bb3' }),
  'win32-x64': Object.freeze({ file: 'lighter-signer-windows-amd64.dll', sha256: '3f6baac6015a27d652971947442c69f26f37cf6bdae7fd74f3c05cd2d8c194b1' }),
});

const DEFAULT_DIR = path.join(__dirname, '..', 'vendor', 'lighter-signer');
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // the largest pinned binary is about 18 MB
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 5;

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function resolveBinary(key = platformKey()) {
  const binary = LIGHTER_SIGNER_BINARIES[key];
  if (!binary) {
    throw new Error(`No pinned Lighter signer for ${key}. Supported: ${Object.keys(LIGHTER_SIGNER_BINARIES).join(', ')}`);
  }
  return binary;
}

function signerUrl(binary) {
  return LIGHTER_SIGNER_BASE_URL + binary.file;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// { ok: true, sha256 } or { ok: false, reason, sha256? }
function verifyFile(filePath, binary) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: `not found at ${filePath}` };
  }
  if (!stat.isFile()) return { ok: false, reason: `${filePath} is not a regular file` };
  const actual = sha256(fs.readFileSync(filePath));
  if (actual !== binary.sha256) {
    return { ok: false, sha256: actual, reason: `sha256 ${actual} does not match the pinned ${binary.sha256}` };
  }
  return { ok: true, sha256: actual };
}

// ---------------------------------------------------------------------------------------------
// HTTPS download with optional CONNECT proxy
// ---------------------------------------------------------------------------------------------

function noProxyMatches(hostname, noProxy) {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  return noProxy.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean).some(entry => {
    if (entry === '*') return true;
    const bare = entry.replace(/^\*?\./, '').replace(/:\d+$/, '');
    return host === bare || host.endsWith(`.${bare}`);
  });
}

function proxyFor(targetUrl, env = process.env) {
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  if (!proxy) return null;
  if (noProxyMatches(targetUrl.hostname, env.NO_PROXY || env.no_proxy)) return null;
  return proxy;
}

function connectThroughProxy(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    if (proxy.protocol !== 'http:') {
      reject(new Error(`Unsupported proxy protocol ${proxy.protocol} in HTTPS_PROXY (only http:// proxies are supported)`));
      return;
    }
    const headers = { Host: `${host}:${port}` };
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    const request = http.request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy refused the tunnel to ${host}:${port} (HTTP ${response.statusCode})`));
        return;
      }
      resolve(socket);
    });
    request.once('timeout', () => request.destroy(new Error(`Proxy CONNECT to ${host}:${port} timed out`)));
    request.once('error', reject);
    request.end();
  });
}

async function httpsGet(url, env) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error(`Refusing to download over ${target.protocol} (${url})`);
  const port = Number(target.port) || 443;
  const proxyUrl = proxyFor(target, env);
  const tunnel = proxyUrl ? await connectThroughProxy(proxyUrl, target.hostname, port) : null;
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      host: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      headers: { 'User-Agent': 'aster-lick-hunter-lighter-signer', Accept: '*/*' },
      timeout: REQUEST_TIMEOUT_MS,
    };
    if (tunnel) {
      // TLS end to end through the tunnel; certificate checked against the target host
      options.createConnection = () => tls.connect({ socket: tunnel, servername: target.hostname });
    }
    const request = https.request(options, resolve);
    request.once('timeout', () => request.destroy(new Error(`Download from ${target.host} timed out`)));
    request.once('error', reject);
    request.end();
  });
}

function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      reject(new Error(`Download is ${declared} bytes, above the ${maxBytes} byte limit`));
      return;
    }
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy(new Error(`Download exceeded the ${maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    response.once('error', reject);
    response.once('aborted', () => reject(new Error('Download was interrupted')));
    response.once('end', () => {
      if (Number.isFinite(declared) && size !== declared) {
        reject(new Error(`Download ended after ${size} of ${declared} bytes`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function download(url, { env = process.env, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await httpsGet(current, env);
    const status = response.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.resume();
      current = new URL(response.headers.location, current).toString();
      continue;
    }
    if (status !== 200) {
      response.resume();
      throw new Error(`Download of ${current} failed with HTTP ${status}`);
    }
    return readBody(response, maxBytes);
  }
  throw new Error(`Too many redirects while downloading ${url}`);
}

// ---------------------------------------------------------------------------------------------
// Install / verify
// ---------------------------------------------------------------------------------------------

function writeAtomically(target, bytes) {
  const temp = `${target}.download-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o644 });
    if (process.platform === 'win32' && fs.existsSync(target)) fs.unlinkSync(target);
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

// Idempotent: a file that already matches the pinned hash is left alone. A missing or mismatching
// file is replaced only by a download whose hash matches. `binary` and `download` are injectable
// for tests.
async function install({
  key = platformKey(),
  dir = DEFAULT_DIR,
  binary = resolveBinary(key),
  download: downloadImpl = download,
  log = () => {},
} = {}) {
  const target = path.join(dir, binary.file);
  const existing = verifyFile(target, binary);
  if (existing.ok) {
    log(`Lighter signer already installed and verified: ${target}`);
    return { status: 'present', path: target, sha256: existing.sha256 };
  }
  if (existing.sha256) log(`Existing ${target} failed verification (${existing.reason}); reinstalling`);

  const url = signerUrl(binary);
  log(`Downloading ${binary.file} from lighter-python@${LIGHTER_SIGNER_COMMIT.slice(0, 7)} ...`);
  const bytes = await downloadImpl(url);
  const actual = sha256(bytes);
  if (actual !== binary.sha256) {
    throw new Error(`Downloaded ${binary.file} has sha256 ${actual}, expected ${binary.sha256}. Nothing was installed.`);
  }

  fs.mkdirSync(dir, { recursive: true });
  writeAtomically(target, bytes);
  const written = verifyFile(target, binary);
  if (!written.ok) throw new Error(`Installed file failed verification: ${written.reason}`);
  log(`Installed ${target} (sha256 ${actual})`);
  return { status: 'installed', path: target, sha256: actual };
}

function verify({ key = platformKey(), dir = DEFAULT_DIR, binary = resolveBinary(key) } = {}) {
  const target = path.join(dir, binary.file);
  return { path: target, ...verifyFile(target, binary) };
}

function parseArgs(argv) {
  const args = { verify: false, help: false, platform: platformKey(), dir: DEFAULT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify') args.verify = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--platform' || arg === '--dir') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--platform') args.platform = value;
      else args.dir = path.resolve(value);
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log([
    'Usage: npm run lighter:signer [-- --verify] [--platform <key>] [--dir <path>]',
    '',
    '  (no option)   download the Lighter signer for this platform into vendor/lighter-signer/',
    '                after checking its sha256; does nothing when a valid copy is present',
    '  --verify      check the installed file against the pinned sha256 without downloading',
    `  --platform    one of ${Object.keys(LIGHTER_SIGNER_BINARIES).join(', ')}`,
    '  --dir         install directory (default: vendor/lighter-signer)',
  ].join('\n'));
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    printUsage();
    return 2;
  }
  if (args.help) {
    printUsage();
    return 0;
  }
  try {
    const binary = resolveBinary(args.platform);
    if (args.verify) {
      const result = verify({ key: args.platform, dir: args.dir, binary });
      if (result.ok) {
        console.log(`Lighter signer OK: ${result.path} (sha256 ${result.sha256})`);
        return 0;
      }
      console.error(`Lighter signer verification failed: ${result.reason}`);
      console.error('Run "npm run lighter:signer" to install it.');
      return 1;
    }
    await install({ key: args.platform, dir: args.dir, binary, log: message => console.log(message) });
    return 0;
  } catch (error) {
    console.error(`Lighter signer: ${error.message}`);
    return 1;
  }
}

module.exports = {
  LIGHTER_SIGNER_COMMIT,
  LIGHTER_SIGNER_BASE_URL,
  LIGHTER_SIGNER_BINARIES,
  DEFAULT_DIR,
  platformKey,
  resolveBinary,
  signerUrl,
  verifyFile,
  noProxyMatches,
  proxyFor,
  download,
  install,
  verify,
  parseArgs,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
