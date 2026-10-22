import crypto from 'node:crypto';
import fetch from 'node-fetch';

// SolarEdge moved its sign-in to AWS Cognito. The hosted login page is a
// browser flow, but the app client also allows USER_SRP_AUTH, which lets us
// prove knowledge of the password without sending it, and without a browser.
const REGION = 'eu-central-1';
const POOL_ID = 'eu-central-1_fVUTz39em';
const CLIENT_ID = 'ugfnsujd3384sshcjehaphlh3';

// RFC 3526 group 15 (3072-bit), as used by Cognito.
const N = BigInt(`0x${[
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD',
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED',
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F',
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B',
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510',
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7',
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C',
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF',
].join('')}`);
const G = 2n;

const sha256 = (...buffers) => crypto.createHash('sha256').update(Buffer.concat(buffers)).digest();

// Big-endian bytes, with a leading zero byte if the top bit is set so the
// value stays positive. This is how Cognito pads values before hashing.
function toBytes(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (/^[89a-f]/i.test(hex)) hex = `00${hex}`;
  return Buffer.from(hex, 'hex');
}

const fromBytes = (buffer) => BigInt(`0x${buffer.toString('hex') || '0'}`);

function modPow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

const K = fromBytes(sha256(toBytes(N), toBytes(G)));

// Cognito's timestamp format: "Thu Oct 22 13:11:30 UTC 2026" (day not padded).
function timestamp(date = new Date()) {
  const [weekday, day, month, year] = date.toUTCString().replace(',', '').split(' ');
  const time = date.toISOString().slice(11, 19);
  return `${weekday} ${month} ${Number(day)} ${time} UTC ${year}`;
}

async function cognito(target, body) {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30 * 1000),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json.message ?? res.statusText);
    error.type = json.__type;
    throw error;
  }
  return json;
}

// Returns { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType }.
async function signIn({ username, password }) {
  const a = fromBytes(crypto.randomBytes(128));
  const A = modPow(G, a, N);

  const challenge = await cognito('InitiateAuth', {
    ClientId: CLIENT_ID,
    AuthFlow: 'USER_SRP_AUTH',
    AuthParameters: { USERNAME: username, SRP_A: A.toString(16) },
  });

  if (challenge.ChallengeName !== 'PASSWORD_VERIFIER') {
    throw new Error(`Unsupported sign-in challenge: ${challenge.ChallengeName}`);
  }

  const {
    SALT: salt,
    SECRET_BLOCK: secretBlock,
    SRP_B: srpB,
    USER_ID_FOR_SRP: userId,
  } = challenge.ChallengeParameters;

  const B = BigInt(`0x${srpB}`);
  if (B % N === 0n) throw new Error('Invalid SRP server value');

  const poolName = POOL_ID.split('_')[1];
  const u = fromBytes(sha256(toBytes(A), toBytes(B)));
  const x = fromBytes(sha256(
    toBytes(BigInt(`0x${salt}`)),
    sha256(Buffer.from(`${poolName}${userId}:${password}`)),
  ));

  const gx = modPow(G, x, N);
  const S = modPow((((B - K * gx) % N) + N) % N, a + u * x, N);

  // HKDF-SHA256 with a single block, as Cognito specifies.
  const prk = crypto.createHmac('sha256', toBytes(u)).update(toBytes(S)).digest();
  const key = crypto.createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from('Caldera Derived Key'), Buffer.from([1])]))
    .digest()
    .subarray(0, 16);

  const time = timestamp();
  const signature = crypto.createHmac('sha256', key)
    .update(Buffer.concat([
      Buffer.from(poolName),
      Buffer.from(userId),
      Buffer.from(secretBlock, 'base64'),
      Buffer.from(time),
    ]))
    .digest('base64');

  const result = await cognito('RespondToAuthChallenge', {
    ClientId: CLIENT_ID,
    ChallengeName: 'PASSWORD_VERIFIER',
    ChallengeResponses: {
      USERNAME: userId,
      PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
      TIMESTAMP: time,
      PASSWORD_CLAIM_SIGNATURE: signature,
    },
  });

  if (!result.AuthenticationResult) {
    throw new Error(`Unsupported sign-in challenge: ${result.ChallengeName}`);
  }

  return result.AuthenticationResult;
}

export default signIn;
