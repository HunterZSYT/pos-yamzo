import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILE_VERSION = 1;
const TERMINAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const PRIVATE_KEY_PATTERN = /^[A-Za-z0-9_-]{60,200}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{59}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;

export interface WebsiteTerminalCredentialProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface WebsiteTerminalRegistration {
  algorithm: "Ed25519";
  terminalCode: string;
  publicKeyBase64Url: string;
  publicKeyFingerprint: string;
  createdAt: string;
}

export interface WebsiteTerminalIdentity {
  privateKey: KeyObject;
  registration: WebsiteTerminalRegistration;
  credentialFilePath: string;
}

export interface WebsiteTerminalProvisioningResult {
  identity: WebsiteTerminalIdentity;
  created: boolean;
  registrationFilePath: string;
  previousCredentialBackupPath: string | null;
}

export interface WebsiteTerminalRestoreResult {
  identity: WebsiteTerminalIdentity;
  displacedCredentialPath: string;
}

export interface WebsiteTerminalCredentialOptions {
  terminalCode: string;
  userDataPath: string;
  protector: WebsiteTerminalCredentialProtector;
  now?: () => Date;
}

export interface WebsiteTerminalProvisioningCommand {
  terminalCode: string;
  rotate: boolean;
}

interface StoredTerminalCredential {
  version: 1;
  algorithm: "Ed25519";
  terminalCode: string;
  publicKeyBase64Url: string;
  publicKeyFingerprint: string;
  encryptedPrivateKey: string;
  createdAt: string;
}

export function parseWebsiteTerminalProvisioningCommand(
  argv: readonly string[]
): WebsiteTerminalProvisioningCommand | null {
  const commands = argv.flatMap((argument) => {
    const provision = argument.match(/^--provision-website-terminal=(.+)$/);
    if (provision) return [{ terminalCode: provision[1], rotate: false }];
    const rotate = argument.match(/^--rotate-website-terminal=(.+)$/);
    return rotate ? [{ terminalCode: rotate[1], rotate: true }] : [];
  });
  if (commands.length === 0) return null;
  if (commands.length !== 1) {
    throw new Error("Specify exactly one website terminal provisioning command.");
  }
  return {
    terminalCode: cleanTerminalCode(commands[0].terminalCode),
    rotate: commands[0].rotate
  };
}

export function loadWebsiteTerminalIdentity(
  options: WebsiteTerminalCredentialOptions
): WebsiteTerminalIdentity {
  const terminalCode = cleanTerminalCode(options.terminalCode);
  assertEncryptionAvailable(options.protector);
  const credentialFilePath = credentialPath(options.userDataPath, terminalCode);
  if (!fs.existsSync(credentialFilePath)) {
    throw new Error(
      `Website terminal key is not provisioned. Run --provision-website-terminal=${terminalCode}.`
    );
  }
  const stat = fs.statSync(credentialFilePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error("The protected website terminal credential file is invalid.");
  }

  let stored: StoredTerminalCredential;
  try {
    stored = parseStoredCredential(
      JSON.parse(fs.readFileSync(credentialFilePath, "utf8")) as unknown,
      terminalCode
    );
  } catch {
    throw new Error("The protected website terminal credential file is invalid.");
  }

  let privateKey: KeyObject;
  try {
    const privateKeyBase64Url = options.protector.decryptString(
      Buffer.from(stored.encryptedPrivateKey, "base64")
    );
    if (!PRIVATE_KEY_PATTERN.test(privateKeyBase64Url)) throw new Error("invalid key");
    privateKey = createPrivateKey({
      key: Buffer.from(privateKeyBase64Url, "base64url"),
      format: "der",
      type: "pkcs8"
    });
  } catch {
    throw new Error("The protected website terminal key could not be decrypted.");
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The protected website terminal key uses an unsupported algorithm.");
  }

  const registration = registrationFromPrivateKey(
    terminalCode,
    privateKey,
    stored.createdAt
  );
  if (
    registration.publicKeyBase64Url !== stored.publicKeyBase64Url
    || registration.publicKeyFingerprint !== stored.publicKeyFingerprint
  ) {
    throw new Error("The protected website terminal credential failed its integrity check.");
  }
  return { privateKey, registration, credentialFilePath };
}

export function provisionWebsiteTerminalIdentity(
  options: WebsiteTerminalCredentialOptions & { rotate?: boolean }
): WebsiteTerminalProvisioningResult {
  const terminalCode = cleanTerminalCode(options.terminalCode);
  assertEncryptionAvailable(options.protector);
  const directory = credentialDirectory(options.userDataPath);
  const credentialFilePath = credentialPath(options.userDataPath, terminalCode);
  const registrationFilePath = registrationPath(options.userDataPath, terminalCode);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (fs.existsSync(credentialFilePath) && !options.rotate) {
    const identity = loadWebsiteTerminalIdentity({ ...options, terminalCode });
    writeRegistrationFile(registrationFilePath, identity.registration);
    return {
      identity,
      created: false,
      registrationFilePath,
      previousCredentialBackupPath: null
    };
  }

  const keyPair = generateKeyPairSync("ed25519");
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const privateKeyBase64Url = keyPair.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  const registration = registrationFromPrivateKey(
    terminalCode,
    keyPair.privateKey,
    createdAt
  );
  const encryptedPrivateKey = options.protector
    .encryptString(privateKeyBase64Url)
    .toString("base64");
  if (encryptedPrivateKey.length < 16 || encryptedPrivateKey.length > 12_000) {
    throw new Error("The operating system returned an invalid encrypted credential.");
  }
  const stored: StoredTerminalCredential = {
    version: FILE_VERSION,
    algorithm: "Ed25519",
    terminalCode,
    publicKeyBase64Url: registration.publicKeyBase64Url,
    publicKeyFingerprint: registration.publicKeyFingerprint,
    encryptedPrivateKey,
    createdAt
  };

  const temporaryPath = `${credentialFilePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });

  let previousCredentialBackupPath: string | null = null;
  try {
    if (fs.existsSync(credentialFilePath)) {
      previousCredentialBackupPath = uniqueBackupPath(
        options.userDataPath,
        terminalCode,
        options.now?.() ?? new Date()
      );
      fs.renameSync(credentialFilePath, previousCredentialBackupPath);
    }
    try {
      fs.renameSync(temporaryPath, credentialFilePath);
    } catch (error) {
      if (
        previousCredentialBackupPath
        && fs.existsSync(previousCredentialBackupPath)
        && !fs.existsSync(credentialFilePath)
      ) {
        fs.renameSync(previousCredentialBackupPath, credentialFilePath);
      }
      throw error;
    }
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }

  const identity = loadWebsiteTerminalIdentity({ ...options, terminalCode });
  writeRegistrationFile(registrationFilePath, identity.registration);
  return {
    identity,
    created: true,
    registrationFilePath,
    previousCredentialBackupPath
  };
}

export function restorePreviousWebsiteTerminalIdentity(
  options: WebsiteTerminalCredentialOptions & { previousCredentialBackupPath: string }
): WebsiteTerminalRestoreResult {
  const terminalCode = cleanTerminalCode(options.terminalCode);
  assertEncryptionAvailable(options.protector);
  const directory = credentialDirectory(options.userDataPath);
  const credentialFilePath = credentialPath(options.userDataPath, terminalCode);
  const backupPath = path.resolve(options.previousCredentialBackupPath);
  const expectedDirectory = `${path.resolve(directory)}${path.sep}`;
  if (
    !backupPath.startsWith(expectedDirectory)
    || !path.basename(backupPath).startsWith(`website-terminal-${terminalCode}.previous-`)
    || !backupPath.endsWith(".protected.json")
    || !fs.existsSync(backupPath)
    || !fs.existsSync(credentialFilePath)
  ) {
    throw new Error("The previous terminal credential backup is unavailable.");
  }

  const displacedCredentialPath = uniqueFailedRotationPath(
    options.userDataPath,
    terminalCode,
    options.now?.() ?? new Date()
  );
  fs.renameSync(credentialFilePath, displacedCredentialPath);
  try {
    fs.renameSync(backupPath, credentialFilePath);
    const identity = loadWebsiteTerminalIdentity({ ...options, terminalCode });
    writeRegistrationFile(registrationPath(options.userDataPath, terminalCode), identity.registration);
    return { identity, displacedCredentialPath };
  } catch (error) {
    if (fs.existsSync(credentialFilePath) && !fs.existsSync(backupPath)) {
      fs.renameSync(credentialFilePath, backupPath);
    }
    if (fs.existsSync(displacedCredentialPath) && !fs.existsSync(credentialFilePath)) {
      fs.renameSync(displacedCredentialPath, credentialFilePath);
    }
    throw error;
  }
}

function registrationFromPrivateKey(
  terminalCode: string,
  privateKey: KeyObject,
  createdAt: string
): WebsiteTerminalRegistration {
  const publicKeyDer = createPublicKey(privateKey).export({
    format: "der",
    type: "spki"
  });
  const publicKeyBase64Url = publicKeyDer.toString("base64url");
  const publicKeyFingerprint = createHash("sha256").update(publicKeyDer).digest("hex");
  if (
    !PUBLIC_KEY_PATTERN.test(publicKeyBase64Url)
    || !FINGERPRINT_PATTERN.test(publicKeyFingerprint)
  ) {
    throw new Error("The generated terminal public key is invalid.");
  }
  return {
    algorithm: "Ed25519",
    terminalCode,
    publicKeyBase64Url,
    publicKeyFingerprint,
    createdAt
  };
}

function parseStoredCredential(
  value: unknown,
  terminalCode: string
): StoredTerminalCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid credential");
  }
  const stored = value as Record<string, unknown>;
  if (
    stored.version !== FILE_VERSION
    || stored.algorithm !== "Ed25519"
    || stored.terminalCode !== terminalCode
    || typeof stored.publicKeyBase64Url !== "string"
    || !PUBLIC_KEY_PATTERN.test(stored.publicKeyBase64Url)
    || typeof stored.publicKeyFingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(stored.publicKeyFingerprint)
    || typeof stored.encryptedPrivateKey !== "string"
    || !/^[A-Za-z0-9+/=]{16,12000}$/.test(stored.encryptedPrivateKey)
    || typeof stored.createdAt !== "string"
    || !Number.isFinite(Date.parse(stored.createdAt))
  ) {
    throw new Error("invalid credential");
  }
  return stored as unknown as StoredTerminalCredential;
}

function writeRegistrationFile(
  filePath: string,
  registration: WebsiteTerminalRegistration
): void {
  fs.writeFileSync(filePath, `${JSON.stringify(registration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function assertEncryptionAvailable(protector: WebsiteTerminalCredentialProtector): void {
  if (!protector.isEncryptionAvailable()) {
    throw new Error(
      "Windows credential encryption is unavailable; terminal provisioning is disabled."
    );
  }
}

function cleanTerminalCode(value: string): string {
  const terminalCode = value.trim();
  if (!TERMINAL_CODE_PATTERN.test(terminalCode)) {
    throw new Error("The website terminal code is invalid.");
  }
  return terminalCode;
}

function credentialDirectory(userDataPath: string): string {
  if (!path.isAbsolute(userDataPath)) {
    throw new Error("The POS user-data path must be absolute.");
  }
  return path.join(userDataPath, "credentials");
}

function credentialPath(userDataPath: string, terminalCode: string): string {
  return path.join(
    credentialDirectory(userDataPath),
    `website-terminal-${terminalCode}.protected.json`
  );
}

function registrationPath(userDataPath: string, terminalCode: string): string {
  return path.join(
    credentialDirectory(userDataPath),
    `website-terminal-${terminalCode}.registration.json`
  );
}

function uniqueBackupPath(
  userDataPath: string,
  terminalCode: string,
  now: Date
): string {
  const timestamp = now.toISOString().replace(/[-:.Z]/g, "").replace("T", "-");
  const directory = credentialDirectory(userDataPath);
  let candidate = path.join(
    directory,
    `website-terminal-${terminalCode}.previous-${timestamp}.protected.json`
  );
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(
      directory,
      `website-terminal-${terminalCode}.previous-${timestamp}-${suffix}.protected.json`
    );
    suffix += 1;
  }
  return candidate;
}

function uniqueFailedRotationPath(
  userDataPath: string,
  terminalCode: string,
  now: Date
): string {
  const timestamp = now.toISOString().replace(/[-:.Z]/g, "").replace("T", "-");
  const directory = credentialDirectory(userDataPath);
  let candidate = path.join(
    directory,
    `website-terminal-${terminalCode}.failed-rotation-${timestamp}.protected.json`
  );
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(
      directory,
      `website-terminal-${terminalCode}.failed-rotation-${timestamp}-${suffix}.protected.json`
    );
    suffix += 1;
  }
  return candidate;
}
