/** Convierte un título en un identificador apto para URL ("¿Qué es DNS?" -> "que-es-dns"). */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[`*_~[\]()<>¿?¡!"'.,:;/\\|{}=+@#$%^&]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}
