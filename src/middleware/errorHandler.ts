import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _: NextFunction // Mark 'next' as unused
): void {
  console.error('Error:', err.stack || err); // Log stack trace

  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal Server Error'
    : err.message || 'Internal Server Error';

  if (!res.headersSent) {
      res.status(statusCode).json({
        error: message,
        timestamp: new Date().toISOString(),
        path: req.path,
      });
  } else {
      console.error("Headers already sent, couldn't send error response.");
  }
}

