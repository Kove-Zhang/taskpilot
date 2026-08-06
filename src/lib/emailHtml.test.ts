import { describe, expect, it } from 'vitest'
import { sanitizeEmailHtml } from './emailHtml'

describe('sanitizeEmailHtml', () => {
  it('retains safe text, tables and HTTPS links while hardening links', () => {
    const result = sanitizeEmailHtml(`
      <h2 style="color: red">本周计划</h2>
      <p>请查看 <a href="https://example.com/docs" onclick="alert(1)">文档</a>。</p>
      <table border="1"><tr><th colspan="2">项目</th></tr><tr><td>TaskPilot</td><td>进行中</td></tr></table>
    `)

    const container = document.createElement('div')
    container.innerHTML = result

    expect(container.querySelector('h2')?.textContent).toBe('本周计划')
    expect(container.querySelector('table')?.textContent).toContain('TaskPilot')
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/docs')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link?.hasAttribute('onclick')).toBe(false)
    expect(link?.hasAttribute('style')).toBe(false)
  })

  it('removes executable content, remote images and dangerous URLs', () => {
    const result = sanitizeEmailHtml(`
      <script>window.__emailXss = true</script>
      <iframe src="https://attacker.example"></iframe>
      <form action="https://attacker.example"><input name="token"></form>
      <svg onload="window.__emailXss = true"><a href="javascript:alert(1)">bad</a></svg>
      <img src="https://tracker.example/pixel.gif" onerror="window.__emailXss = true">
      <a href="javascript:alert(1)">危险链接</a>
      <p onmouseover="window.__emailXss = true">保留文字</p>
    `)

    const container = document.createElement('div')
    container.innerHTML = result

    expect(container.querySelectorAll('script, iframe, form, input, svg, img')).toHaveLength(0)
    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(container.querySelector('p')?.textContent).toBe('保留文字')
    expect(result).not.toContain('tracker.example')
    expect(result).not.toContain('javascript:')
  })

  it('rejects non-http(s)/mailto links but keeps mailto links', () => {
    const result = sanitizeEmailHtml(`
      <a href="data:text/html,boom">data</a>
      <a href="ftp://example.com/file">ftp</a>
      <a href="mailto:team@example.com">邮件</a>
    `)

    const links = Array.from(document.createRange().createContextualFragment(result).querySelectorAll('a'))
    expect(links[0].hasAttribute('href')).toBe(false)
    expect(links[1].hasAttribute('href')).toBe(false)
    expect(links[2].getAttribute('href')).toBe('mailto:team@example.com')
  })
})