import { createInterface } from 'node:readline/promises';
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const a = await rl.question('q? ');
  console.log('got', JSON.stringify(a));
} finally {
  rl.close();
}
process.exitCode = 1;
console.log('end of script reached');
