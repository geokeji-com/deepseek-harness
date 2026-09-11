import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const USERS_FILE = process.env.USERS_FILE
  ?? '/home/dsh/.config/deepseek-harness/multiuser/users.json'
const PASSWORD_FILE = process.env.PASSWORD_FILE
  ?? '/home/dsh/.config/deepseek-harness/multiuser/new-user-passwords.txt'
const IDS = ['owner', 'member2', 'member3', 'member4']

function readUsers() {
  if (!existsSync(USERS_FILE)) return { users: [] }
  return JSON.parse(readFileSync(USERS_FILE, 'utf8'))
}

function writeUsers(value) {
  const temporary = `${USERS_FILE}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, USERS_FILE)
}

function hashPassword(password) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%+-_'
  const bytes = randomBytes(24)
  return [...bytes].map(value => alphabet[value % alphabet.length]).join('')
}

function init(ownerHash) {
  if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/u.test(ownerHash)) {
    throw new Error('invalid owner password hash')
  }
  const generated = []
  const users = IDS.map((id, index) => {
    if (id === 'owner') {
      return { id, port: 3090 + index, enabled: true, passwordScrypt: ownerHash }
    }
    const password = generatePassword()
    generated.push(`${id}=${password}`)
    return { id, port: 3090 + index, enabled: true, passwordScrypt: hashPassword(password) }
  })
  writeUsers({ users })
  writeFileSync(PASSWORD_FILE, `${generated.join('\n')}\n`, { mode: 0o600 })
}

function add(id, portValue) {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(id)) throw new Error('invalid user id')
  const data = readUsers()
  if (data.users.some(user => user.id === id)) throw new Error('user already exists')
  const password = generatePassword()
  const port = portValue === undefined || portValue === ''
    ? 3090 + data.users.length
    : Number(portValue)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
  if (data.users.some(user => user.port === port)) throw new Error('port already exists')
  data.users.push({
    id,
    port,
    enabled: true,
    passwordScrypt: hashPassword(password),
  })
  writeUsers(data)
  process.stdout.write(`${password}\n`)
}

function rotate(id) {
  const data = readUsers()
  const user = data.users.find(candidate => candidate.id === id)
  if (user === undefined) throw new Error('user not found')
  const password = generatePassword()
  user.passwordScrypt = hashPassword(password)
  writeUsers(data)
  process.stdout.write(`${password}\n`)
}

function setEnabled(id, enabled) {
  const data = readUsers()
  const user = data.users.find(candidate => candidate.id === id)
  if (user === undefined) throw new Error('user not found')
  user.enabled = enabled
  writeUsers(data)
}

const [command, ...args] = process.argv.slice(2)
if (command === 'init') init(args[0])
else if (command === 'add') add(args[0], args[1])
else if (command === 'rotate') rotate(args[0])
else if (command === 'enable') setEnabled(args[0], true)
else if (command === 'disable') setEnabled(args[0], false)
else if (command === 'list') {
  for (const user of readUsers().users) {
    process.stdout.write(`${user.id}\t${user.port}\t${user.enabled ? 'enabled' : 'disabled'}\n`)
  }
} else {
  throw new Error('usage: user-admin.mjs init|add|rotate|enable|disable|list')
}
