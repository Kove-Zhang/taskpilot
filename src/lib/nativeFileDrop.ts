export type NativeFileDropType = 'enter' | 'over' | 'drop' | 'leave'

export interface NativeDroppedFilePayload {
  name: string
  mimeType: string
  dataBase64: string
}

export interface NativeFileDropEvent {
  type: NativeFileDropType
  files?: NativeDroppedFilePayload[]
  errors?: string[]
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function nativeDroppedFilePayloadsToFiles(
  payloads: readonly NativeDroppedFilePayload[],
): File[] {
  return payloads.map(({ name, mimeType, dataBase64 }) => (
    new File([decodeBase64(dataBase64)], name, { type: mimeType || 'application/octet-stream' })
  ))
}


