#!__NODE__
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
appendFileSync(join(process.env.HOME, 'calls.jsonl'), JSON.stringify({ args, env: process.env, pid: process.pid }) + '\n')
if (args.length === 1 && args[0] === 'skill') {
  process.stdout.write(readFileSync(join(process.env.HOME, 'guide.txt'), 'utf8'))
} else if (args.length === 3 && args[0] === 'nodejs' && args[1] === '-e') {
  for await (const _ of process.stdin) { /* the official CLI waits for input EOF before evaluating */ }
  await import('data:text/javascript;base64,' + Buffer.from(args[2]).toString('base64'))
} else {
  throw new Error('unsupported fixture invocation')
}
