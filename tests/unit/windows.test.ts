import { describe, expect, it } from 'vitest'
import { cals, equilibrio, generarEjercicio, licenciar } from '@/engines/windows/licencias'

describe('Licencias de Windows Server 2025', () => {
  it('mínimos por procesador y por servidor, juegos de Standard y Datacenter', () => {
    expect(licenciar({ procesadores: 1, nucleos: 4 }, 0, 'Standard').totalNucleos).toBe(16)
    expect(licenciar({ procesadores: 2, nucleos: 6 }, 2, 'Standard').totalNucleos).toBe(16)
    expect(licenciar({ procesadores: 2, nucleos: 12 }, 2, 'Standard').totalNucleos).toBe(24)
    expect(licenciar({ procesadores: 1, nucleos: 16 }, 5, 'Standard').totalNucleos).toBe(48)
    expect(licenciar({ procesadores: 1, nucleos: 9 }, 0, 'Standard').totalNucleos).toBe(16)
    expect(licenciar({ procesadores: 2, nucleos: 9 }, 0, 'Standard')).toMatchObject({ totalNucleos: 20, paquetes16: 1, paquetes2: 2 })
    expect(licenciar({ procesadores: 2, nucleos: 16 }, 40, 'Datacenter')).toMatchObject({ totalNucleos: 32, vmsCubiertas: Infinity })
    expect(equilibrio({ procesadores: 1, nucleos: 16 })).toBe(11)
    expect(cals(40, 55).tipo).toBe('usuario')
    expect(cals(90, 30).tipo).toBe('dispositivo')
    const rng = () => 0.42
    expect(generarEjercicio(rng).respuesta).toBeGreaterThanOrEqual(16)
  })
})
