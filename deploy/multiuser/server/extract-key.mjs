import { readFileSync, writeFileSync } from 'node:fs'
import YAML from '/home/dsh/.local/share/deepseek-harness/profiles/node_modules/yaml/dist/index.js'

const source = process.argv[2]
const output = process.argv[3]
const document = YAML.parse(readFileSync(source, 'utf8'))
const key = document?.refs?.DEEPSEEK_API_KEY

if (typeof key !== 'string' || key.length < 8 || /[\r\n\0]/u.test(key)) {
  throw new Error('DEEPSEEK_API_KEY is missing or invalid')
}

const quoted = /^[A-Za-z0-9._:/-]+$/u.test(key)
  ? key
  : `"${key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
writeFileSync(output, `DEEPSEEK_API_KEY=${quoted}\n`, { mode: 0o600 })
