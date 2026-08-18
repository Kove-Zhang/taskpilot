export type LLMErrorClass =
  | 'cancelled'
  | 'timeout'
  | 'transient'
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'auth'
  | 'invalid_request'
  | 'capability_mismatch'
  | 'invalid_response'
  | 'output_truncated'
  | 'schema_invalid'
  | 'security_blocked'
  | 'budget_exhausted'
  | 'unknown'

export interface ClassifiedLLMErrorInfo {
  errorClass: LLMErrorClass
  message: string
  status?: number
  retryable: boolean
  failoverable: boolean
  userActionRequired: boolean
  cause?: unknown
  retryAfterMs?: number
}

export interface LLMErrorOptions {
  status?: number
  retryable?: boolean
  failoverable?: boolean
  userActionRequired?: boolean
  cause?: unknown
  retryAfterMs?: number
}

/** Error carrying the LLM-layer classification used by retry and routing. */
export class ClassifiedLLMError extends Error {
  readonly errorClass: LLMErrorClass
  readonly status?: number
  readonly retryable: boolean
  readonly failoverable: boolean
  readonly userActionRequired: boolean
  readonly cause?: unknown
  readonly retryAfterMs?: number

  constructor(errorClass: LLMErrorClass, message: string, options: LLMErrorOptions = {}) {
    super(message)
    this.name = 'ClassifiedLLMError'
    this.errorClass = errorClass
    this.status = options.status
    this.retryable = options.retryable ?? isTransientLLMErrorClass(errorClass)
    this.failoverable = options.failoverable ?? isFailoverableLLMErrorClass(errorClass)
    this.userActionRequired = options.userActionRequired ?? isUserActionRequiredLLMErrorClass(errorClass)
    this.cause = options.cause
    this.retryAfterMs = options.retryAfterMs
  }
}

export function isTransientLLMErrorClass(errorClass: LLMErrorClass): boolean {
  return errorClass === 'timeout'
    || errorClass === 'transient'
    || errorClass === 'network'
    || errorClass === 'rate_limited'
    || errorClass === 'server_error'
}

export function isFailoverableLLMErrorClass(errorClass: LLMErrorClass): boolean {
  return errorClass === 'timeout'
    || errorClass === 'transient'
    || errorClass === 'network'
    || errorClass === 'rate_limited'
    || errorClass === 'server_error'
    || errorClass === 'capability_mismatch'
}

export function isUserActionRequiredLLMErrorClass(errorClass: LLMErrorClass): boolean {
  return errorClass === 'auth'
    || errorClass === 'output_truncated'
    || errorClass === 'budget_exhausted'
    || errorClass === 'invalid_request'
    || errorClass === 'capability_mismatch'
    || errorClass === 'security_blocked'
}

export function isClassifiedLLMError(error: unknown): error is ClassifiedLLMError {
  return error instanceof ClassifiedLLMError
}

