declare module 'jsonwebtoken' {
  export interface SignOptions {
    expiresIn?: string | number;
  }

  export function sign(payload: object, secret: string, options?: SignOptions): string;
  export function verify(token: string, secret: string): unknown;

  const jwt: {
    sign: typeof sign;
    verify: typeof verify;
  };

  export default jwt;
}
