import { describe, expect, it } from 'vitest'
import { evaluar, type VmSpec } from '@/engines/virtualizacion/recursos'
import { costos, nucleosVsphere, nucleosWindows, puntaje, CRITERIOS } from '@/engines/virtualizacion/plataformas'

const vm = (nombre: string, vcpu: number, ramGb: number, uso: VmSpec['uso'] = 'baja', ramUsoPct = 40, so = 'ubuntu'): VmSpec => ({ nombre, vcpu, ramGb, uso, ramUsoPct, so })
const host = { hilos: 16, ramGb: 64, reservaGb: 4 }

describe('Recursos virtuales', () => {
  it('prometer más vCPU que hilos está bien con poca carga', () => {
    const r = evaluar(host, Array.from({ length: 10 }, (_, i) => vm(`vm${i}`, 4, 4)), { globo: false, compartir: false, swapHost: true })
    expect(r.ratio).toBe(2.5)
    expect(r.esperaCpu).toBe('baja')
    expect(r.estado).toBe('ok')
  })
  it('con carga alta aparece la espera de CPU', () => {
    const r = evaluar(host, Array.from({ length: 8 }, (_, i) => vm(`vm${i}`, 4, 4, 'alta')), { globo: false, compartir: false, swapHost: true })
    expect(r.esperaCpu).toBe('alta')
    expect(r.estado).toBe('problema')
  })
  it('una VM con más vCPU que hilos no arranca', () => {
    const r = evaluar(host, [vm('grande', 24, 8)], { globo: false, compartir: false, swapHost: true })
    expect(r.mensajes[0]).toContain('no puede arrancar')
  })
  it('sobreasignar memoria funciona con el globo y falla sin él', () => {
    const vms = Array.from({ length: 10 }, (_, i) => vm(`vm${i}`, 2, 8, 'baja', 40))
    const sin = evaluar(host, vms, { globo: false, compartir: false, swapHost: true })
    expect(sin.faltanteGb).toBeGreaterThan(0)
    expect(sin.mensajes.join(' ')).toContain('swap')
    const con = evaluar(host, vms, { globo: true, compartir: true, swapHost: true })
    expect(con.faltanteGb).toBe(0)
    expect(con.recuperadaGloboGb).toBeGreaterThan(0)
    expect(con.recuperadaCompartirGb).toBeGreaterThan(0)
  })
})

describe('Comparar plataformas', () => {
  it('los mínimos de núcleos', () => {
    expect(nucleosWindows({ hosts: 1, zocalos: 1, nucleosPorZocalo: 8, anios: 3, vmsWindows: true })).toBe(16)
    expect(nucleosWindows({ hosts: 1, zocalos: 2, nucleosPorZocalo: 12, anios: 3, vmsWindows: true })).toBe(24)
    expect(nucleosVsphere({ hosts: 1, zocalos: 2, nucleosPorZocalo: 12, anios: 3, vmsWindows: true })).toBe(32)
  })
  it('las VM con Windows suman la licencia de Windows a cualquier hipervisor', () => {
    const infra = { hosts: 3, zocalos: 1, nucleosPorZocalo: 16, anios: 3, vmsWindows: true }
    const c = costos(infra, { vsphereNucleoAnio: 200, windows16: 6771, proxmoxZocaloAnio: 0 })
    const pve = c.find((x) => x.plataforma === 'proxmox')!
    const hv = c.find((x) => x.plataforma === 'hyperv')!
    expect(pve.windows).toBe(hv.total)
    expect(c.find((x) => x.plataforma === 'vsphere')!.hipervisor).toBe(3 * 16 * 200 * 3)
  })
  it('la matriz de decisión depende de los pesos', () => {
    const soloCosto = Object.fromEntries(CRITERIOS.map((c) => [c.id, c.id === 'costo' ? 3 : 0]))
    expect(puntaje(soloCosto).proxmox).toBe(100)
    const soloWindows = Object.fromEntries(CRITERIOS.map((c) => [c.id, c.id === 'windows' ? 3 : 0]))
    expect(puntaje(soloWindows).hyperv).toBe(100)
  })
})
