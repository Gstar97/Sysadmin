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

test('consola de Python: corre de verdad, verifica el ejercicio y corta un bucle infinito', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/galeria#automatizacion')
  const ej = page.getByRole('region', { name: 'Contar errores en un log' })
  await ej.getByRole('button', { name: 'Ver solución' }).click()
  await ej.getByRole('button', { name: 'Cargarla en el editor' }).click()
  await ej.getByRole('button', { name: 'Ejecutar' }).click()
  await expect(ej.getByText('Ejercicio completado')).toBeVisible({ timeout: 60_000 })
  await expect(ej.getByLabel('Salida del programa')).toContainText('Errores: 2')

  const libre = page.getByRole('region', { name: 'Consola libre' })
  await libre.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('while True:\npass')
  await libre.getByRole('button', { name: 'Ejecutar' }).click()
  await expect(libre.getByText(/se cortó/)).toBeVisible({ timeout: 20_000 })
})

test('consola de PromQL: tabla, error y pasos que avanzan', async ({ page }) => {
  await page.goto('/galeria#automatizacion')
  const ej = page.getByRole('region', { name: 'Primeros pasos con PromQL' })
  const consulta = ej.getByRole('textbox', { name: /Consulta de PromQL/ })
  await consulta.fill('rate(up)')
  await consulta.press('Enter')
  await expect(ej.getByRole('alert')).toContainText('expected type range vector in call to function "rate"')
  await consulta.fill('up == 0')
  await consulta.press('Enter')
  await expect(ej.getByText('Paso 2 de 3')).toBeVisible()
  await expect(ej.getByRole('table')).toContainText('up{instance="web03:9100", job="node"}')
  await ej.getByRole('button', { name: 'Ver solución' }).click()
  await ej.getByRole('button', { name: 'Cargarla en la consola' }).click()
  await ej.getByRole('button', { name: 'Ejecutar' }).click()
  await expect(ej.getByText('Paso 3 de 3')).toBeVisible()
  await ej.getByRole('tab', { name: 'Gráfico' }).click()
  await expect(ej.locator('svg[role="img"] path')).toHaveCount(3)
})
