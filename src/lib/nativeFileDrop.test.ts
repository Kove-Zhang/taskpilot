import { describe, expect, it } from 'vitest'
import { nativeDroppedFilePayloadsToFiles } from './nativeFileDrop'

describe('nativeDroppedFilePayloadsToFiles', () => {
  it('将 Tauri 原生拖放字节转换为浏览器 File', async () => {
    const files = nativeDroppedFilePayloadsToFiles([
      { name: '说明.txt', mimeType: 'text/plain', dataBase64: 'SGk=' },
    ])

    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('说明.txt')
    expect(files[0].type).toBe('text/plain')
    expect(await files[0].text()).toBe('Hi')
  })

  it('缺少 MIME 类型时使用通用二进制类型', () => {
    const [file] = nativeDroppedFilePayloadsToFiles([
      { name: 'unknown.bin', mimeType: '', dataBase64: 'AAE=' },
    ])

    expect(file.type).toBe('application/octet-stream')
  })

  it('保留多个拖放文件及其顺序', () => {
    const files = nativeDroppedFilePayloadsToFiles([
      { name: 'a.txt', mimeType: 'text/plain', dataBase64: 'AQ==' },
      { name: 'b.txt', mimeType: 'text/plain', dataBase64: 'Ag==' },
    ])

    expect(files.map((file) => file.name)).toEqual(['a.txt', 'b.txt'])
  })
})
