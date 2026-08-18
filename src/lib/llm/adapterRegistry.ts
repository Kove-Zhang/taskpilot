import { ClassifiedLLMError } from './errors'
import { OpenAIChatAdapter } from './adapters/openaiChat'
import type { ApiProtocol, ProviderAdapter } from './types'

const adapters = new Map<ApiProtocol, ProviderAdapter>([
  ['openai-chat', new OpenAIChatAdapter('openai-chat')],
  ['custom-compatible', new OpenAIChatAdapter('custom-compatible')],
])

export function registerProviderAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.protocol, adapter)
}

export function hasProviderAdapter(protocol: ApiProtocol): boolean {
  return adapters.has(protocol)
}

export function getProviderAdapter(protocol: ApiProtocol): ProviderAdapter {
  const adapter = adapters.get(protocol)
  if (!adapter) {
    throw new ClassifiedLLMError('invalid_request', `暂不支持服务商协议：${protocol}`, {
      retryable: false,
      failoverable: false,
      userActionRequired: true,
    })
  }
  return adapter
}
