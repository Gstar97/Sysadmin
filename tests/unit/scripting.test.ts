import { describe, expect, it } from 'vitest'
import { createBashSession, stripAnsi } from '@/engines/shell'

async function session() {
  const sh = createBashSession({ usuario: 'ana', usuarios: [{ nombre: 'ana', sudo: true }], archivos: { '/home/ana/u.csv': 'usuario,depto\nlperez,ventas\ncgomez,compras\nmruiz,ventas\n' } })
  const run = async (cmd: string) => {
    const r = await sh.run(cmd)
    return { out: stripAnsi(r.chunks.filter((c) => c.stream === 'out').map((c) => c.text).join('')), err: stripAnsi(r.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('')), code: sh.lastExit }
  }
  return { sh, run }
}

describe('intérprete de bash para scripts', () => {
  it('arreglos indexados y asociativos', async () => {
    const { run } = await session()
    expect((await run('a=(uno "dos tres" cuatro); echo ${#a[@]} ${a[1]}; a+=(cinco); echo "${a[@]: -1}"')).out).toBe('3 dos tres\ncinco\n')
    expect((await run('declare -A m=([ana]=30 [bob]=25); k=bob; echo ${m[$k]} ${#m[@]}')).out).toBe('25 2\n')
    expect((await run('for x in "${a[@]}"; do echo "[$x]"; done | head -2')).out).toBe('[uno]\n[dos tres]\n')
  })

  it('expansiones de parámetros', async () => {
    const { run } = await session()
    expect((await run('f=/var/log/app.log.1; echo ${f##*/} ${f%/*} ${f%.*} ${#f} ${f/log/LOG} ${f//log/LOG}')).out).toBe('app.log.1 /var/log /var/log/app.log 18 /var/LOG/app.log.1 /var/LOG/app.LOG.1\n')
    expect((await run('n=; echo ${n:-vacío} ${x:=def} $x; s=Hola; echo ${s^^} ${s,,} ${s:1:2}')).out).toBe('vacío def def\nHOLA hola ol\n')
  })

  it('aritmética: (( )), for ((;;)), let y $(( ))', async () => {
    const { run } = await session()
    expect((await run('t=0; for ((i=1; i<=4; i++)); do ((t += i)); done; echo $t; (( t > 5 )) && echo grande')).out).toBe('10\ngrande\n')
    expect((await run('x=7; let "y = x % 3"; echo $y $(( x > 5 ? 1 : 0 )) $((2**8))')).out).toBe('1 1 256\n')
  })

  it('getopts, trap EXIT/ERR, set -euo pipefail y exec >> log', async () => {
    const { run } = await session()
    await run(`cat > s.sh <<'FIN'
#!/bin/bash
set -euo pipefail
LOG=/home/ana/s.log
exec >> "$LOG" 2>&1
trap 'echo "error en la línea $LINENO"' ERR
trap 'echo fin' EXIT
while getopts "n:" o; do case $o in n) N=$OPTARG ;; esac; done
echo "N=$N"
false
echo nunca
FIN`)
    const r = await run('bash s.sh -n 3; echo rc=$?')
    expect(r.out).toBe('rc=1\n')
    expect((await run('cat s.log')).out).toBe('N=3\nerror en la línea 9\nfin\n')
  })

  it('bash -x muestra cada comando', async () => {
    const { run } = await session()
    await run("printf 'x=1\\necho \"v $x\"\\n' > t.sh")
    expect((await run('bash -x t.sh')).err).toBe("+ x=1\n+ echo 'v 1'\n")
  })

  it('awk con arreglos, END y printf; sed con varios comandos', async () => {
    const { run } = await session()
    expect((await run("awk -F, 'NR>1 { n[$2]++ } END { for (d in n) printf \"%s=%d\\n\", d, n[d] }' u.csv | sort")).out).toBe('compras=1\nventas=2\n')
    expect((await run("sed 's/,/;/g; 1d' u.csv | head -1")).out).toBe('lperez;ventas\n')
  })

  it('tar, mapfile, <( ) y mktemp', async () => {
    const { run } = await session()
    expect((await run('mkdir d && echo hola > d/a && tar czf d.tgz d && tar tzf d.tgz')).out).toBe('d/\nd/a\n')
    expect((await run('tar czf vacio.tgz /no/existe; echo rc=$?')).out).toBe('rc=2\n')
    expect((await run('mapfile -t l < u.csv; echo ${#l[@]}; diff <(echo a) <(echo a) && echo iguales')).out).toBe('4\niguales\n')
    expect((await run('t=$(mktemp); [[ -f $t && $t == /tmp/tmp.* ]] && echo ok')).out).toBe('ok\n')
  })
})
