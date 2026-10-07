// Sets the admin username/password stored (hashed) in docs/data/admin.json.
//
//   node tools/set-password.mjs <username> <password>
//   node tools/set-password.mjs --random            (generates a password)
//
// Changing the password from the command line clears the encrypted GitHub
// token, because it was encrypted with the old password. Re-enter the token
// in Admin > Publishing afterwards. Changing it inside the admin panel keeps it.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adminFile = path.join(root, 'docs', 'data', 'admin.json');
const ITERATIONS = 310000;

let [username, password] = process.argv.slice(2);
let generated = false;
if (username === '--random' || !username) {
  username = username === '--random' ? (password || 'admin') : 'admin';
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  password = Array.from(randomBytes(20), (b) => alphabet[b % alphabet.length]).join('');
  generated = true;
}
if (!password || password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');

const existing = existsSync(adminFile) ? JSON.parse(readFileSync(adminFile, 'utf8')) : {};
const admin = {
  username,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: salt.toString('base64') },
  passwordHash: hash.toString('base64'),
  github: existing.github || { owner: '', repo: '', branch: 'main', root: 'docs' },
  token: null,
};
writeFileSync(adminFile, JSON.stringify(admin, null, 2) + '\n');

if (generated) {
  const credFile = path.join(root, 'ADMIN-CREDENTIALS.txt');
  writeFileSync(credFile, `Envoy admin panel\nUsername: ${username}\nPassword: ${password}\n\nChange it in Admin > Account, or run: node tools/set-password.mjs <user> <password>\nThis file is git-ignored. Delete it once you have stored the password somewhere safe.\n`);
  console.log(`Admin credentials written to ${credFile}`);
} else {
  console.log(`Password updated for "${username}".`);
}
