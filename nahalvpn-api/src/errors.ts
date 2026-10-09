/** Domain errors carry a stable machine code (shown to the app) and an HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const Errors = {
  invalidCredentials: () => new AppError("invalid_credentials", 401),
  lockedOut: () => new AppError("too_many_attempts", 429),
  accountDisabled: () => new AppError("account_disabled", 403),
  subscriptionExpired: () => new AppError("subscription_expired", 403),
  deviceLimit: (devices: unknown[]) => new AppError("device_limit_reached", 409, undefined, { devices }),
  invalidToken: () => new AppError("invalid_token", 401),
  notFound: (what: string) => new AppError("not_found", 404, `${what} not found`),
  forbidden: () => new AppError("forbidden", 403),
  conflict: (what: string) => new AppError("conflict", 409, what),
} as const;
