export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  if (error instanceof AppError) {
    const candidate = error.providerDiagnostic;
    const diagnostic = ['QLOO_AUTH', 'QLOO_RATE_LIMIT', 'QLOO_UPSTREAM'].includes(error.code) &&
      candidate?.provider === 'qloo' && ['search', 'tags', 'insights'].includes(candidate.operation) &&
      Number.isInteger(candidate.httpStatus) && candidate.httpStatus >= 100 && candidate.httpStatus <= 599
      ? { provider: 'qloo', operation: candidate.operation, httpStatus: candidate.httpStatus } : null;
    return { status: error.status, body: { error: {
      code: error.code,
      message: error.message + (diagnostic ? ` (Qloo ${diagnostic.operation}: HTTP ${diagnostic.httpStatus}.)` : ''),
      ...(diagnostic ? { diagnostic } : {})
    } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'The brief could not be completed. Your previous revision is unchanged.' } } };
}
