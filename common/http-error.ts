// Standard HTTP error envelope shared by server routes and API clients.
export interface HttpErrorResponse {
  success: false;
  error: string;
  errorCode: string;
  retryable: boolean;
  details?: string;
}

