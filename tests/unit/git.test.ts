import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi, verifyBash } from '@/engines/shell'
import type { BashStateInput } from '@/engines/shell/schema'

async function session(st: BashStateInput) {
  const sh = createBashSession(st)
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

const admin: BashStateInput = {
  distro: 'ubuntu',
  hostname: 'admin01',
  usuario: 'ana',
  usuarios: [{ nombre: 'ana', sudo: true, clave_ssh: true }],
  paquetes: { instalados: ['git'] },
  red: { interfaces: [{ nombre: 'enp1s0', ip: '192.168.10.5/24', estado: 'UP' }], puerta_enlace: '192.168.10.1' },
  servidores: [{ hostname: 'git01', ip: '192.168.10.40', clave_conocida: 'si', distro: 'ubuntu', usuarios: [{ nombre: 'ana', clave_ssh: true }], paquetes: { instalados: ['git'] } }],
}

describe('git', () => {
  it('init, identidad, add, commit, status, diff, log y .gitignore', async () => {
    const { run, sh } = await session(admin)
    await run('mkdir infra && cd infra')
    expect((await run('git init')).err).toContain("Using 'master'")
    await run('git config --global user.name "Ana Gómez"')
    await run('git config --global user.email ana@ejemplo.test')
    await run('git branch -m main')
    await run('echo "server_name web01;" > nginx.conf')
    await run('echo "*.log" > .gitignore')
    await run('echo ruido > acceso.log')
    expect((await run('git status')).out).toMatch(/Untracked files:[\s\S]*\.gitignore[\s\S]*nginx\.conf/)
    expect((await run('git status')).out).not.toContain('acceso.log')
    await run('git add .')
    const c = await run('git commit -m "Configuración inicial"')
    expect(c.out).toMatch(/\[main \(root-commit\) [0-9a-f]{7}\] Configuración inicial/)
    expect(c.out).toContain('2 files changed')
    await run('echo "listen 443 ssl;" >> nginx.conf')
    expect((await run('git diff')).out).toContain('+listen 443 ssl;')
    expect((await run('git status -s')).out).toBe(' M nginx.conf\n')
    await run('git commit -am "HTTPS"')
    expect((await run('git log --oneline')).out).toMatch(/[0-9a-f]{7} \(HEAD -> main\) HTTPS\n[0-9a-f]{7} Configuración inicial\n/)
    expect(verifyBash(sh, { git_repo: '/home/ana/infra', rama: 'main', commits_min: 2, limpio: true, versionado: 'nginx.conf', no_versionado: 'acceso.log' }).ok).toBe(true)
  })
  it('ramas, fusión con conflicto y su resolución', async () => {
    const { run, sh } = await session(admin)
    await run('git config --global user.name Ana && git config --global user.email ana@ejemplo.test && git config --global init.defaultBranch main')
    await run('mkdir r && cd r && git init -q')
    await run('printf "puerto=80\\nusuario=www\\nlog=info\\n" > app.conf && git add . && git commit -qm base')
    await run('git switch -c cambio-puerto')
    await run('sed -i s/puerto=80/puerto=8080/ app.conf && git commit -qam "Puerto 8080"')
    await run('git switch main')
    await run('sed -i s/log=info/log=debug/ app.conf && git commit -qam "Log debug"')
    const m = await run('git merge cambio-puerto -m "Fusión"')
    expect(m.out).toContain("Merge made by the 'ort' strategy")
    expect((await run('cat app.conf')).out).toBe('puerto=8080\nusuario=www\nlog=debug\n')
    await run('git switch -c otra && sed -i s/usuario=www/usuario=nginx/ app.conf && git commit -qam nginx')
    await run('git switch main && sed -i s/usuario=www/usuario=apache/ app.conf && git commit -qam apache')
    const c = await run('git merge otra')
    expect(c.out).toContain('CONFLICT (content): Merge conflict in app.conf')
    expect((await run('cat app.conf')).out).toContain('<<<<<<< HEAD\nusuario=apache\n=======\nusuario=nginx\n>>>>>>> otra')
    expect(verifyBash(sh, { git_repo: '/home/ana/r', en_conflicto: true }).ok).toBe(true)
    expect((await run('git commit -m x')).err).toContain('unmerged files')
    await run('printf "puerto=8080\\nusuario=nginx\\nlog=debug\\n" > app.conf && git add app.conf && git commit -m "Fusión de otra"')
    expect(verifyBash(sh, { git_repo: '/home/ana/r', en_conflicto: false, limpio: true, fusionada: 'otra' }).ok).toBe(true)
    expect((await run('git log --oneline --graph | head -1')).out).toMatch(/^\* {3}/)
  })
  it('remoto por ssh: push, clone en otro lado, push rechazado y pull', async () => {
    const { run, sh } = await session(admin)
    await run('git config --global user.name Ana && git config --global user.email ana@ejemplo.test && git config --global init.defaultBranch main')
    await run('ssh ana@git01 git init --bare -b main /home/ana/infra.git')
    await run('mkdir infra && cd infra && git init -q && echo hola > LEEME.txt && git add . && git commit -qm inicio')
    await run('git remote add origin ana@git01:infra.git')
    expect((await run('git push')).err).toContain('has no upstream branch')
    expect((await run('git push -u origin main')).err).toContain('* [new branch]      main -> main')
    await run('cd ~ && git clone ana@git01:infra.git copia && cd copia && echo cambio >> LEEME.txt && git commit -qam "desde la copia" && git push')
    await run('cd ~/infra && echo otro > otro.txt && git add . && git commit -qm otro')
    expect((await run('git push')).err).toContain('[rejected]')
    expect((await run('git pull')).err).toContain('divergent branches')
    await run('git config pull.rebase false')
    expect((await run('git pull')).out).toContain("Merge made by the 'ort' strategy")
    expect((await run('git push')).code).toBe(0)
    expect(verifyBash(sh, { git_repo: '/home/ana/infra', sincronizado: true, remoto: 'origin' }).ok).toBe(true)
    expect(verifyBash(sh, { en: 'git01', verificar: { git_repo: '/home/ana/infra.git', commits_min: 4 } }).ok).toBe(true)
  })
  it('hook pre-commit que bloquea secretos; filter-repo saca la contraseña del historial', async () => {
    const { run, sh } = await session({ ...admin, paquetes: { instalados: ['git', 'gitleaks'] } })
    await run('git config --global user.name Ana && git config --global user.email ana@ejemplo.test && git config --global init.defaultBranch main')
    await run('mkdir app && cd app && git init -q && echo "host=db01" > db.env && git add . && git commit -qm inicio')
    await run('echo "password=Sup3rSecreta2026" >> db.env && git commit -qam "agrega clave"')
    expect((await run('gitleaks detect -v')).err).toContain('leaks found: 1')
    expect((await run('git log -S Sup3rSecreta2026 --oneline')).out).toContain('agrega clave')
    await run('echo "Sup3rSecreta2026==>***REMOVED***" > /tmp/reemplazos.txt')
    expect((await run('git filter-repo --replace-text /tmp/reemplazos.txt')).out).toContain('Completely finished')
    expect(verifyBash(sh, { git_repo: '/home/ana/app', historial_no_contiene: 'Sup3rSecreta2026' }).ok).toBe(true)
    expect((await run('cat db.env')).out).toContain('***REMOVED***')
    await run("printf '#!/bin/bash\\ngitleaks protect --staged -v || { echo \"Commit bloqueado: hay un secreto\"; exit 1; }\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit")
    await run('echo "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" > ci.env && git add ci.env')
    const c = await run('git commit -m "token"')
    expect(c.out).toContain('Commit bloqueado')
    expect(c.code).toBe(1)
    expect(verifyBash(sh, { git_repo: '/home/ana/app', hook: 'pre-commit', no_versionado: 'ci.env' }).ok).toBe(true)
  })
  it('restore, reset, revert, stash y etiquetas', async () => {
    const { run } = await session(admin)
    await run('git config --global user.name Ana && git config --global user.email ana@ejemplo.test && git config --global init.defaultBranch main')
    await run('mkdir r && cd r && git init -q && echo v1 > a.txt && git add . && git commit -qm uno && echo v2 > a.txt && git commit -qam dos')
    await run('echo roto > a.txt')
    await run('git restore a.txt')
    expect((await run('cat a.txt')).out).toBe('v2\n')
    await run('git revert HEAD --no-edit')
    expect((await run('cat a.txt')).out).toBe('v1\n')
    expect((await run('git log --oneline | head -1')).out).toContain('Revert "dos"')
    await run('echo wip > a.txt && git stash')
    expect((await run('cat a.txt')).out).toBe('v1\n')
    await run('git stash pop')
    expect((await run('cat a.txt')).out).toBe('wip\n')
    await run('git restore a.txt && git tag -a v1.0 -m "Primera versión" && git tag')
    expect((await run('git tag')).out).toBe('v1.0\n')
    await run('git reset --hard HEAD~2')
    expect((await run('git log --oneline')).out.trim().split('\n')).toHaveLength(1)
  })
})
