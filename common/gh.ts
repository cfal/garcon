export type GhAvailabilityReason =
  | 'authenticated'
  | 'unauthenticated'
  | 'gh_missing'
  | 'auth_error'
  | 'unknown';

export interface GhStatusResponse {
  available: boolean;
  authenticated: boolean;
  reason: GhAvailabilityReason;
  login?: string;
  host?: string;
}
