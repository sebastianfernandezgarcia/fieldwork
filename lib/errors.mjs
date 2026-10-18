export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  if (error instanceof AppError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'The brief could not be completed. Your previous revision is unchanged.' } } };
}
