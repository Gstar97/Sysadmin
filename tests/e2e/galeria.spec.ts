import { expect, test } from '@playwright/test'

test('la galería carga todos los interactivos', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/galeria')
  for (const titulo of ['Terminal Linux (bash)', 'Windows PowerShell', 'Consola Cisco IOS', 'Armador de topologías', 'Simulador de paquetes', 'Editor de configuración con validación']) {
    await expect(page.getByRole('heading', { name: titulo })).toBeVisible()
  }
  await page.locator('#topologia').scrollIntoViewIfNeeded()
  await expect(page.locator('#topologia .react-flow__node')).toHaveCount(4)
  await page.locator('#editor').scrollIntoViewIfNeeded()
  await expect(page.getByText(/2 errores/).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('consola Cisco: VLAN y guardado', async ({ page }) => {
  await page.goto('/galeria#cisco')
  const sec = page.locator('#cisco')
  const input = sec.getByRole('textbox', { name: 'Comando' })
  for (const c of ['enable', 'conf t', 'hostname SW1', 'vlan 10', 'name VENTAS', 'vlan 20', 'name IT', 'exit']) {
    await input.fill(c)
    await input.press('Enter')
  }
  await expect(sec.getByText('Paso 2 de 3')).toBeVisible()
})
