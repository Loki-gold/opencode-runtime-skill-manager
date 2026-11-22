export type ErrorCode =
  | "INVALID_INPUT"
  | "INVALID_SOURCE"
  | "UNSUPPORTED_SOURCE"
  | "NOT_FOUND"
  | "AMBIGUOUS_SKILL"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "TOO_LARGE"
  | "TOO_MANY_FILES"
  | "UNSAFE_PATH"
  | "UNSAFE_CONTENT"
  | "INVALID_SKILL"
  | "CONFLICT"
  | "NOT_MANAGED"
  | "REGISTRATION_FAILED"
  | "VERIFICATION_FAILED"
  | "PERMISSION_DENIED"
  | "CANCELLED"
  | "IO_ERROR"
  | "INTERNAL"

export class SkillManagerError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, options: { hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = "SkillManagerError"
    this.code = code
    this.hint = options.hint
    this.details = options.details
  }

  toJSON() {
    return {
      ok: false as const,
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    }
  }
}

export function toSkillManagerError(error: unknown): SkillManagerError {
  if (error instanceof SkillManagerError) return error
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new SkillManagerError("TIMEOUT", "The operation timed out.", {
        hint: "Try again, increase requestTimeoutMs, or use a smaller source.",
        cause: error,
      })
    }
    return new SkillManagerError("INTERNAL", error.message, { cause: error })
  }
  return new SkillManagerError("INTERNAL", String(error))
}
