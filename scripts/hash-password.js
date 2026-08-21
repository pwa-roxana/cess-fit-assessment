// Usage: node scripts/hash-password.js "your-chosen-password"
// Run this once per password (up to two). Copy each printed hash into your
// .env file as STAFF_PASSWORD_HASH_1 and, optionally, STAFF_PASSWORD_HASH_2.
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your-chosen-password"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nCopy this into your .env file as STAFF_PASSWORD_HASH_1 (or _2 for a second password):\n');
console.log(hash);
console.log('');
