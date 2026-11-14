import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, hotp, normalizeRecoveryCode, otpauthUri, totpCode, verifyTotp } from "./totp";

/** Segredo ASCII dos vetores do RFC 6238 (SHA-1). */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("bate com os vetores do RFC 6238 (SHA-1, 8 dígitos)", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, expected] of vectors) expect(totpCode(RFC_SECRET, seconds * 1000, 8), String(seconds)).toBe(expected);
  });

  it("HOTP bate com os vetores do RFC 4226", () => {
    const secret = Buffer.from("12345678901234567890");
    expect([0, 1, 2, 3].map((counter) => hotp(secret, counter))).toEqual(["755224", "287082", "359152", "969429"]);
  });

  it("base32 vai e volta", () => {
    const bytes = Buffer.from("segredo qualquer 123");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Decode("jbsw y3dp").toString()).toBe("Hello");
    expect(() => base32Decode("!!!")).toThrow();
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("janela ±1 passo e nada além", () => {
    const t = 1_700_000_000_000;
    const at = (offsetSteps: number) => totpCode(RFC_SECRET, t + offsetSteps * 30_000);
    expect(verifyTotp(RFC_SECRET, at(0), t)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-1), t)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(1), t)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-2), t)).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(2), t)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", t)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", t)).toBeNull();
    expect(verifyTotp(RFC_SECRET, ` ${at(0).slice(0, 3)} ${at(0).slice(3)} `, t)).not.toBeNull();
  });

  it("não aceita o mesmo código (nem um mais antigo) depois de usado", () => {
    const t = 1_700_000_000_000;
    const step = verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t), t)!;
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t), t, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t - 30_000), t, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, t + 30_000), t, step)).toBe(step + 1);
  });

  it("otpauth:// com segredo, emissor e parâmetros padrão", () => {
    expect(otpauthUri("ABCDEFGH")).toBe("otpauth://totp/Cyno?secret=ABCDEFGH&issuer=Cyno&algorithm=SHA1&digits=6&period=30");
  });

  it("códigos de recuperação: 10, únicos, XXXXX-XXXXX; o hash ignora hífen e caixa", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{5}-[A-HJ-KM-NP-Z2-9]{5}$/);
    const code = codes[0]!;
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code.toLowerCase().replace("-", " ")));
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizeRecoveryCode("ab-cd 12")).toBe("ABCD12");
  });
});
