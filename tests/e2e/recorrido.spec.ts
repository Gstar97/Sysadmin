import { expect, test } from '@playwright/test'

test('inicio, mapa, módulo y lección', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('main')).toBeVisible()
  await page.goto('/mapa')
  await expect(page.getByRole('heading', { name: 'Carrera Sysadmin (contenido de prueba)' })).toBeVisible()
  await expect(page.getByText('Nivel de prueba').first()).toBeVisible()
  await page.goto('/modulo/n0-m1')
  await expect(page.getByRole('heading', { name: /Redes básicas/ })).toBeVisible()
  await page.getByRole('link', { name: /Puertos y protocolos de transporte/ }).first().click()
  await expect(page).toHaveURL(/\/leccion\/n0-m1-l1/)
  await expect(page.getByRole('heading', { name: /0\.1\.1 Puertos y protocolos de transporte/ })).toBeVisible()
  await expect(page.locator('#tcp-y-udp')).toBeVisible()
  await expect(page.locator('#errores-comunes')).toBeVisible()
  await expect(page.locator('#resumen')).toBeVisible()
})

test('la terminal de la lección verifica el ejercicio', async ({ page }) => {
  await page.goto('/leccion/n0-m1-l1')
  const input = page.getByRole('textbox', { name: 'Comando' })
  await input.fill('ss -tln')
  await input.press('Enter')
  await expect(page.getByText('Ejercicio completado')).toBeVisible()
  await expect(page.getByText(':443').first()).toBeVisible()
})

test('pregunta dentro de la lección y mini test', async ({ page }) => {
  await page.goto('/leccion/n0-m1-l1')
  const practica = page.locator('div', { hasText: 'Para practicar' }).filter({ has: page.getByRole('button', { name: 'Comprobar' }) }).last()
  await practica.getByText('El programa al que va el tráfico dentro de un equipo').click()
  await practica.getByRole('button', { name: 'Comprobar' }).click()
  await expect(practica.getByText('La IP lleva el tráfico al equipo y el puerto, al programa.')).toBeVisible()
  await page.getByRole('button', { name: 'Empezar el mini test' }).click()
  await expect(page.getByText('Pregunta 1')).toBeVisible()
})

test('las notas personales se guardan', async ({ page }) => {
  await page.goto('/leccion/n0-m1-l1')
  const notas = page.getByRole('textbox', { name: 'Notas personales de esta lección' })
  await notas.fill('ss -tln muestra lo que escucha')
  await expect(page.getByText('Guardado')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Notas personales de esta lección' })).toHaveValue('ss -tln muestra lo que escucha')
})

test('buscador y glosario', async ({ page }) => {
  await page.goto('/buscar?q=puerto')
  await expect(page.getByRole('link', { name: /Puertos y protocolos de transporte/ }).first()).toBeVisible()
  await page.goto('/glosario')
  await expect(page.getByText('Número de 0 a 65535').first()).toBeVisible()
})

test('caso real y examen del módulo', async ({ page }) => {
  await page.goto('/caso/n0-m1')
  await page.getByRole('button', { name: /Entrar por SSH a srv-web01 y ver el estado de nginx/ }).click()
  await expect(page.getByText('nginx: [emerg] unexpected "}"')).toBeVisible()
  await page.goto('/examen/n0-m1')
  await expect(page.getByRole('button', { name: 'Empezar el examen' })).toBeVisible()
  await expect(page.getByText(/Cuenta como examen de salteo/)).toBeVisible()
})

test('modo oscuro', async ({ page }) => {
  await page.goto('/')
  const html = page.locator('html')
  for (let i = 0; i < 3; i++) {
    if ((await html.getAttribute('data-theme')) === 'dark') break
    await page.getByRole('button', { name: /Cambiar tema/ }).click()
  }
  await expect(html).toHaveAttribute('data-theme', 'dark')
})
