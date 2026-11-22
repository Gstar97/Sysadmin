/**
 * Ansible Vault simulado: el mismo formato de archivo ($ANSIBLE_VAULT;1.1;AES256 y líneas
 * hexadecimales de 80 columnas) y el mismo comportamiento (con la contraseña equivocada no se
 * puede leer). El cifrado es un juguete: alcanza para practicar, no para guardar secretos.
 */

export class VaultError extends Error {}

export const VAULT_HEADER = '$ANSIBLE_VAULT;1.1;AES256'

function hash(s: string): number[] {
  let h1 = 0x811c9dc5
  let h2 = 0x6a09e667
  for (const c of s) {
    h1 = Math.imul(h1 ^ c.charCodeAt(0), 16777619) >>> 0
    h2 = Math.imul(h2 + c.charCodeAt(0), 2246822507) >>> 0
  }
  const out: number[] = []
  for (let i = 0; i < 32; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 15), 2654435761) >>> 0
    h2 = (Math.imul(h2 ^ (h2 >>> 13), 3266489909) + i) >>> 0
    out.push((h1 ^ h2) & 0xff)
  }
  return out
}

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => (s.match(/../g) ?? []).map((h) => parseInt(h, 16))

function keystream(password: string, salt: string, n: number): number[] {
  const out: number[] = []
  let block = 0
  while (out.length < n) out.push(...hash(`${password}:${salt}:${block++}`))
  return out.slice(0, n)
}

/** Cifra un texto. La sal sale del contenido, así el resultado es estable (útil para las pruebas). */
export function encrypt(plain: string, password: string, vaultId?: string): string {
  const data = [...new TextEncoder().encode(plain)]
  const salt = hex(hash(`salt:${plain}:${password}`))
  const ks = keystream(password, salt, data.length)
  const cipher = data.map((b, i) => b ^ ks[i])
  const mac = hex(hash(`mac:${password}:${salt}:${hex(cipher)}`))
  const inner = `${salt}\n${mac}\n${hex(cipher)}`
  const outer = hex([...new TextEncoder().encode(inner)])
  const header = vaultId ? `$ANSIBLE_VAULT;1.2;AES256;${vaultId}` : VAULT_HEADER
  return `${header}\n${(outer.match(/.{1,80}/g) ?? []).join('\n')}\n`
}

export function isVault(text: string): boolean {
  return text.trimStart().startsWith('$ANSIBLE_VAULT;')
}

/** Descifra; si la contraseña no es la correcta, da el error de Ansible. */
export function decrypt(text: string, password: string, source = 'input'): string {
  const lines = text.trim().split('\n').map((l) => l.trim())
  if (!lines[0]?.startsWith('$ANSIBLE_VAULT;')) throw new VaultError(`input is not vault encrypted data for ${source}`)
  const outer = lines.slice(1).join('')
  let inner: string
  try {
    inner = new TextDecoder().decode(Uint8Array.from(unhex(outer)))
  } catch {
    throw new VaultError(`Vault format unhexlify error: Odd-length string for ${source}`)
  }
  const [salt, mac, body] = inner.split('\n')
  if (!salt || !mac || body === undefined) throw new VaultError(`Vault format unhexlify error for ${source}`)
  if (hex(hash(`mac:${password}:${salt}:${body}`)) !== mac) throw new VaultError(`Decryption failed (no vault secrets were found that could decrypt) on ${source}`)
  const cipher = unhex(body)
  const ks = keystream(password, salt, cipher.length)
  return new TextDecoder().decode(Uint8Array.from(cipher.map((b, i) => b ^ ks[i])))
}

/** Una variable cifrada dentro de un YAML (!vault |). */
export class VaultString {
  constructor(public readonly text: string) {}
}

/** ansible-vault encrypt_string: el bloque para pegar en un YAML. */
export function encryptString(value: string, password: string, name?: string): string {
  const body = encrypt(value, password)
    .trimEnd()
    .split('\n')
    .map((l) => `          ${l}`)
    .join('\n')
  return `${name ? `${name}: ` : ''}!vault |\n${body}\n`
}
