import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWebsiteTerminalIdentity,
  parseWebsiteTerminalProvisioningCommand,
  provisionWebsiteTerminalIdentity,
  restorePreviousWebsiteTerminalIdentity,
  type WebsiteTerminalCredentialProtector
} from "../src/main/services/websiteTerminalCredentials";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yamzo-terminal-key-"));
  temporaryDirectories.push(directory);
  return directory;
}

function opaqueProtector(): WebsiteTerminalCredentialProtector {
  const values = new Map<string, string>();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const encrypted = randomBytes(32).toString("hex");
      values.set(encrypted, value);
      return Buffer.from(encrypted, "utf8");
    },
    decryptString: (value) => {
      const decrypted = values.get(value.toString("utf8"));
      if (!decrypted) throw new Error("unavailable protected value");
      return decrypted;
    }
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("website terminal credential provisioning", () => {
  it("persists only an OS-protected private key and public registration material", () => {
    const userDataPath = temporaryDirectory();
    const protector = opaqueProtector();
    const result = provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector,
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });

    expect(result.created).toBe(true);
    expect(result.identity.registration).toMatchObject({
      algorithm: "Ed25519",
      terminalCode: "YAMZO_UTTARA_01",
      createdAt: "2026-08-08T10:00:00.000Z"
    });
    expect(result.identity.registration.publicKeyBase64Url).toMatch(/^[A-Za-z0-9_-]{59}$/);
    expect(result.identity.registration.publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const privateKeyBase64Url = result.identity.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url");
    const protectedFile = fs.readFileSync(result.identity.credentialFilePath, "utf8");
    const registrationFile = fs.readFileSync(result.registrationFilePath, "utf8");
    expect(protectedFile).not.toContain(privateKeyBase64Url);
    expect(registrationFile).not.toContain(privateKeyBase64Url);
    expect(registrationFile).toContain(result.identity.registration.publicKeyBase64Url);

    const loaded = loadWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector
    });
    expect(loaded.registration).toEqual(result.identity.registration);
  });

  it("is idempotent by default and keeps an encrypted recovery copy on explicit rotation", () => {
    const userDataPath = temporaryDirectory();
    const protector = opaqueProtector();
    const first = provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector,
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const repeated = provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector
    });
    expect(repeated.created).toBe(false);
    expect(repeated.identity.registration.publicKeyFingerprint).toBe(
      first.identity.registration.publicKeyFingerprint
    );

    const rotated = provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector,
      rotate: true,
      now: () => new Date("2026-08-09T10:00:00.000Z")
    });
    expect(rotated.identity.registration.publicKeyFingerprint).not.toBe(
      first.identity.registration.publicKeyFingerprint
    );
    expect(rotated.previousCredentialBackupPath).toBeTruthy();
    expect(fs.existsSync(rotated.previousCredentialBackupPath!)).toBe(true);
  });

  it("fails closed when OS encryption is unavailable or the protected file is tampered", () => {
    const userDataPath = temporaryDirectory();
    expect(() => provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => ""
      }
    })).toThrow(/encryption is unavailable/i);

    const protector = opaqueProtector();
    const result = provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector
    });
    const stored = JSON.parse(fs.readFileSync(result.identity.credentialFilePath, "utf8")) as Record<string, unknown>;
    stored.publicKeyFingerprint = "0".repeat(64);
    fs.writeFileSync(result.identity.credentialFilePath, JSON.stringify(stored));
    expect(() => loadWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector
    })).toThrow(/integrity check/i);
  });

  it("restores the protected previous key when remote rotation is not accepted", () => {
    const userDataPath = temporaryDirectory();
    const protector = opaqueProtector();
    const first = provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector,
      now: () => new Date("2026-08-08T10:00:00.000Z")
    });
    const rotated = provisionWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector,
      rotate: true,
      now: () => new Date("2026-08-09T10:00:00.000Z")
    });

    const restored = restorePreviousWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector,
      previousCredentialBackupPath: rotated.previousCredentialBackupPath!,
      now: () => new Date("2026-08-09T10:01:00.000Z")
    });

    expect(restored.identity.registration.publicKeyFingerprint).toBe(
      first.identity.registration.publicKeyFingerprint
    );
    expect(fs.existsSync(restored.displacedCredentialPath)).toBe(true);
    expect(loadWebsiteTerminalIdentity({
      terminalCode: "YAMZO_UTTARA_01",
      userDataPath,
      protector
    }).registration.publicKeyFingerprint).toBe(first.identity.registration.publicKeyFingerprint);
  });

  it("parses only one bounded packaged provisioning command", () => {
    expect(parseWebsiteTerminalProvisioningCommand([
      "Yamzo POS.exe",
      "--provision-website-terminal=YAMZO_UTTARA_01"
    ])).toEqual({ terminalCode: "YAMZO_UTTARA_01", rotate: false });
    expect(parseWebsiteTerminalProvisioningCommand([
      "Yamzo POS.exe",
      "--rotate-website-terminal=YAMZO_UTTARA_01"
    ])).toEqual({ terminalCode: "YAMZO_UTTARA_01", rotate: true });
    expect(parseWebsiteTerminalProvisioningCommand(["Yamzo POS.exe"])).toBeNull();
    expect(() => parseWebsiteTerminalProvisioningCommand([
      "--provision-website-terminal=../bad"
    ])).toThrow(/invalid/i);
  });
});
