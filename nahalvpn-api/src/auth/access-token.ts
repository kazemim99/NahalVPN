import { SignJWT, jwtVerify } from "jose";
import { Errors } from "../errors.js";

export interface AccessClaims {
  userId: number;
  deviceId: string;
}

const ISSUER = "nahalvpn-api";

export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(secret: string, private readonly ttlMs: number) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(claims: AccessClaims, now: number): Promise<string> {
    const iat = Math.floor(now / 1000);
    return new SignJWT({ did: claims.deviceId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(claims.userId))
      .setIssuer(ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(iat + Math.floor(this.ttlMs / 1000))
      .sign(this.key);
  }

  async verify(token: string, now: number): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        algorithms: ["HS256"],
        currentDate: new Date(now),
      });
      const userId = Number(payload.sub);
      const deviceId = payload.did;
      if (!Number.isInteger(userId) || typeof deviceId !== "string") throw Errors.invalidToken();
      return { userId, deviceId };
    } catch {
      throw Errors.invalidToken();
    }
  }
}
