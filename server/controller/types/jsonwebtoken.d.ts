declare module 'jsonwebtoken' {
  export interface SignOptions {
    expiresIn?: string | number;
    algorithm?: 'HS256' | 'HS384' | 'HS512';
  }

  export function sign(payload: object, secret: string, options?: SignOptions): string;
  export function verify(token: string, secret: string, options?: { algorithms?: readonly string[]; ignoreExpiration?: boolean }): unknown;

  const jwt: {
    sign: typeof sign;
    verify: typeof verify;
  };

  export default jwt;
}
