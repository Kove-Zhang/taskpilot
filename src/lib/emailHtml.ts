const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'kbd', 'li', 'ol', 'p', 'pre', 'q',
  's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

const DROP_WITH_CONTENT_TAGS = new Set([
  'applet', 'audio', 'base', 'embed', 'form', 'frame', 'frameset', 'head',
  'iframe', 'input', 'link', 'math', 'meta', 'noscript', 'object', 'picture',
  'script', 'source', 'style', 'svg', 'template', 'textarea', 'track', 'video',
])

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  abbr: new Set(['title']),
  ol: new Set(['start', 'type']),
  q: new Set(['cite']),
  table: new Set(['summary']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
}

function isSafeLink(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

/**
 * Converts untrusted email HTML into a deliberately small, static reading subset.
 * Remote images, inline styles, scripts, forms, SVG and non-http(s)/mailto links
 * are excluded so opening a saved email cannot execute sender supplied content.
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return ''

  const parser = new DOMParser()
  const document = parser.parseFromString(html, 'text/html')
  const elements = Array.from(document.body.querySelectorAll('*'))

  for (const element of elements) {
    const tagName = element.tagName.toLowerCase()

    if (DROP_WITH_CONTENT_TAGS.has(tagName)) {
      element.remove()
      continue
    }

    if (!ALLOWED_TAGS.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }

    const allowed = ALLOWED_ATTRIBUTES[tagName] || new Set<string>()
    for (const attribute of Array.from(element.attributes)) {
      if (!allowed.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name)
      }
    }

    if (tagName === 'a') {
      const href = element.getAttribute('href')
      if (!href || !isSafeLink(href)) {
        element.removeAttribute('href')
      } else {
        element.setAttribute('target', '_blank')
        element.setAttribute('rel', 'noopener noreferrer')
      }
    }
  }

  return document.body.innerHTML
}