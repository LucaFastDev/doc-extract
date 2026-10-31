// How an eval document prints its dates and numbers (issue #43 criterion 1). The values file holds
// every value as the app stores it, dates as YYYY-MM-DD and amounts as plain decimals; a document
// prints them in its own style, as real documents do, so the eval measures Claude reading
// "14.09.2026" or "1.234,56 €" back into the stored form. make-documents.ts draws with these, and
// documents.test.ts formats each expected value the same way to find it in the document's text.

export type DateStyle = 'iso' | 'dmy.' | 'dmy/' | 'dmy-' | 'mdy/' | 'long-en' | 'long-us' | 'long-de' | 'long-fr' | 'long-es'

/** Grouping and decimal marks: plain 1234.56, en 1,234.56, eu 1.234,56, fr 1 234,56, ch 1'234.56. */
export type NumberStyle = 'plain' | 'en' | 'eu' | 'fr' | 'ch'

const MONTHS: Record<'en' | 'de' | 'fr' | 'es', string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
}

/** A YYYY-MM-DD date as the document prints it. */
export function formatDate(iso: string, style: DateStyle): string {
  const [y, m, d] = iso.split('-')
  const day = String(Number(d))
  const month = Number(m) - 1
  switch (style) {
    case 'iso':
      return iso
    case 'dmy.':
      return `${d}.${m}.${y}`
    case 'dmy/':
      return `${d}/${m}/${y}`
    case 'dmy-':
      return `${d}-${m}-${y}`
    case 'mdy/':
      return `${m}/${d}/${y}`
    case 'long-en':
      return `${day} ${MONTHS.en[month]} ${y}`
    case 'long-us':
      return `${MONTHS.en[month]} ${day}, ${y}`
    case 'long-de':
      return `${day}. ${MONTHS.de[month]} ${y}`
    case 'long-fr':
      return `${day} ${MONTHS.fr[month]} ${y}`
    case 'long-es':
      return `${day} de ${MONTHS.es[month]} de ${y}`
  }
}

const MARKS: Record<NumberStyle, { group: string; point: string }> = {
  plain: { group: '', point: '.' },
  en: { group: ',', point: '.' },
  eu: { group: '.', point: ',' },
  fr: { group: ' ', point: ',' },
  ch: { group: "'", point: '.' },
}

/** A plain decimal ("-1234.5", "2") with the style's marks; its decimals stay as they are. */
export function formatNumber(decimal: string, style: NumberStyle): string {
  const negative = decimal.startsWith('-')
  const [whole, fraction] = decimal.replace(/^-/, '').split('.')
  const { group, point } = MARKS[style]
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group)
  return `${negative ? '-' : ''}${grouped}${fraction !== undefined ? `${point}${fraction}` : ''}`
}

/** A percentage as printed: 19 as "19%", 8.1 as "8,1 %" in the styles that put a space before it. */
export function formatPercent(decimal: string, style: NumberStyle): string {
  return `${formatNumber(decimal, style)}${style === 'eu' || style === 'fr' ? ' %' : '%'}`
}
