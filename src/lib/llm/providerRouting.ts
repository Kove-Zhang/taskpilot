import { ClassifiedLLMError } from './errors'
import { hasProviderAdapter } from './adapterRegistry'
import type { ProviderProfile, TaskProfile } from './types'

export type ProviderRouteDegradation =
  | 'structured-output-downgraded'
  | 'reasoning-disabled'

export interface ProviderRouteDecision {
  compatible: boolean
  task: TaskProfile
  degradations: ProviderRouteDegradation[]
  reason?: string
}

export interface ProviderRouteOptions {
  /**
   * Experimental routing may permit explicitly supported task degradations,
   * but it never disables protocol or capability compatibility checks.
   */
  allowExperimentalDegradations?: boolean
}

/**
 * Evaluates a provider against the concrete task requirements without looking
 * at model names. The adapter remains responsible for serializing any allowed
 * capability downgrade (for example json_object instead of json_schema).
 */
export function evaluateProviderRoute(
  provider: ProviderProfile,
  task: TaskProfile,
  options: ProviderRouteOptions = {},
): ProviderRouteDecision {
  if (!hasProviderAdapter(provider.apiProtocol)) {
    return {
      compatible: false,
      task: { ...task },
      degradations: [],
      reason: `暂不支持服务商协议：${provider.apiProtocol}`,
    }
  }

  if (task.needsVision && !provider.capabilities.vision) {
    return {
      compatible: false,
      task: { ...task },
      degradations: [],
      reason: '当前任务包含图片，但该服务商未声明支持视觉输入',
    }
  }

  const degradations: ProviderRouteDegradation[] = []
  const resolvedTask: TaskProfile = { ...task }

  // Structured extraction is a hard requirement. Sending the request without
  // a response format would silently turn a structured task into free-form
  // text and makes the downstream validator/repair contract unreliable.
  if (task.needsStructuredOutput && provider.capabilities.structuredOutput === 'none') {
    return {
      compatible: false,
      task: { ...task },
      degradations: [],
      reason: '当前任务需要结构化输出，但该服务商未声明支持 JSON Object 或 JSON Schema',
    }
  }

  if (task.reasoning !== 'disabled' && !provider.capabilities.reasoning) {
    if (!options.allowExperimentalDegradations) {
      return {
        compatible: false,
        task: { ...task },
        degradations: [],
        reason: '当前任务需要推理能力，但该服务商未声明支持 Reasoning',
      }
    }
    resolvedTask.reasoning = 'disabled'
    degradations.push('reasoning-disabled')
  }

  return {
    compatible: true,
    task: resolvedTask,
    degradations,
  }
}

export function assertSupportedProviderProtocol(provider: ProviderProfile): void {
  if (!hasProviderAdapter(provider.apiProtocol)) {
    throw new ClassifiedLLMError('invalid_request', `暂不支持服务商协议：${provider.apiProtocol}`, {
      retryable: false,
      failoverable: false,
      userActionRequired: true,
    })
  }
}

export function createProviderCapabilityMismatchError(
  task: TaskProfile,
  reason: string,
): ClassifiedLLMError {
  const taskDescription = task.needsVision ? '视觉输入' : task.needsStructuredOutput ? '结构化输出' : '任务能力'
  return new ClassifiedLLMError('capability_mismatch', `${taskDescription}没有可用的服务商：${reason}`, {
    retryable: false,
    failoverable: false,
    userActionRequired: true,
  })
}
