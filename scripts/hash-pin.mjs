import { randomBytes, scryptSync } from 'node:crypto';
const pin = process.argv[2];
if (!/^\d{4}$/.test(pin || '')) { console.error('Usage: npm run hash-pin -- 1234'); process.exit(1); }
const salt = randomBytes(16);
const hash = scryptSync(pin, salt, 64);
console.log(`scrypt:${salt.toString('hex')}:${hash.toString('hex')}`);
