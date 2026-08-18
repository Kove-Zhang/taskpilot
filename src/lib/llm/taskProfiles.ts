import type { LLMTaskType, TaskProfile } from './types'

const TASK_PROFILES: Record<LLMTaskType, TaskProfile> = {
  'todo-extraction': {
    type: 'todo-extraction',
    needsVision: false,
    needsStructuredOutput: true,
    maxInputChars: 8_000,
    maxOutputTokens: 2_000,
    temperature: 0,
    reasoning: 'disabled',
    allowFailover: true,
    allowRepair: true,
  },
  writing: {
    type: 'writing',
    needsVision: false,
    needsStructuredOutput: false,
    maxInputChars: 6_000,
    maxOutputTokens: 4_000,
    reasoning: 'disabled',
    allowFailover: true,
    allowRepair: false,
  },
  'prompt-optimization': {
    type: 'prompt-optimization',
    needsVision: false,
    needsStructuredOutput: false,
    // Full focus rules must be visible to the model; a partial prefix causes destructive summaries.
    maxInputChars: 12_000,
    maxOutputTokens: 3_000,
    temperature: 0.2,
    reasoning: 'low',
    allowFailover: true,
    allowRepair: false,
  },
  'history-learning': {
    type: 'history-learning',
    needsVision: false,
    needsStructuredOutput: false,
    maxInputChars: 15_000,
    maxOutputTokens: 3_000,
    temperature: 0.2,
    reasoning: 'low',
    allowFailover: true,
    allowRepair: false,
  },
  'provider-health-check': {
    type: 'provider-health-check',
    needsVision: false,
    needsStructuredOutput: false,
    maxInputChars: 500,
    maxOutputTokens: 200,
    temperature: 0,
    reasoning: 'disabled',
    allowFailover: false,
    allowRepair: false,
  },
  'schema-repair': {
    type: 'schema-repair',
    needsVision: false,
    needsStructuredOutput: true,
    maxInputChars: 8_000,
    maxOutputTokens: 1_500,
    temperature: 0,
    reasoning: 'disabled',
    allowFailover: true,
    allowRepair: false,
  },
}

/** Returns a defensive copy so callers cannot mutate global task defaults. */
export function getTaskProfile(taskType: LLMTaskType): TaskProfile {
  return { ...TASK_PROFILES[taskType] }
}

export function isLLMTaskType(value: string): value is LLMTaskType {
  return value in TASK_PROFILES
}

export const DEFAULT_TASK_PROFILES: Readonly<Record<LLMTaskType, TaskProfile>> = TASK_PROFILES
