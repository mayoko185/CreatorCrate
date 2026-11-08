// A3.3b-2 F7 — Windows trust boundary of the comic preparation cache root.
//
// The cache deletes by path, so whoever can rename or replace a directory on the cache root's
// physical path can redirect its removals (a junction in place of a renamed ancestor leads them
// into project storage). On POSIX the cache judges this from ownership and mode bits. On Windows
// it depends on the directories' access control lists, which Node cannot read; this module reads
// them with the operating system's own Windows PowerShell (always present, no extra tools) and
// judges them here.
//
// Who is trusted: this user, SYSTEM, Administrators and TrustedInstaller (OWNER RIGHTS counts as
// the owner, who must be one of them). Everyone else is less trusted, including groups this user
// belongs to (Users, Authenticated Users, Everyone ...), whose other members are other people.
// AppContainer and capability SIDs (S-1-15-*) grant nothing on their own (Windows requires the
// ordinary entries to grant the same access too), so this user's sandboxed apps count as the
// user; CREATOR OWNER / CREATOR GROUP entries only shape what is inherited by new objects, which
// only trusted principals create here. Deny entries are ignored: they can only narrow access,
// so ignoring them can only refuse more.
//
// What must hold (assessWindowsDirectoryChain), for every directory D on the path with parent P:
//   - D cannot be replaced: less-trusted principals may not both remove D from P (DELETE or
//     ownership-level control of D, or DELETE_CHILD or control of P) and create an entry in P
//     (ADD_FILE / ADD_SUBDIRECTORY or control of P). Either alone redirects nothing: an
//     ancestor moved away leaves the path missing, and an addition beside D changes nothing.
//   - no directory is a reparse point, and its owner is trusted (an owner can rewrite its ACL).
// and for the root itself: no less-trusted principal holds any right to write, delete, rename,
// re-own or re-ACL it, effective or inherited by what is created in it (the staging directories
// and their pack files, which inherit the root's ACL).
//
// The root is created with exactly such an ACL (createPrivateWindowsDirectories: protected from
// inheritance, full control for this user, SYSTEM and Administrators only) atomically, by
// CreateDirectory with that security descriptor, so nothing is ever exposed in between. An
// existing directory is never re-permissioned: a handle opened while it was more permissive
// would keep that access, so an existing non-private root is refused instead.

import { execFile } from 'node:child_process';
import path from 'node:path';

const TRUSTED_SIDS = new Set([
  'S-1-5-18', // SYSTEM
  'S-1-5-32-544', // Administrators
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', // TrustedInstaller
]);
const OWNER_RIGHTS = 'S-1-3-4';
// Placeholders that apply only to newly created objects (their creator), never by themselves.
const CREATOR_SIDS = new Set(['S-1-3-0', 'S-1-3-1']);

// Access mask bits (directory meanings).
const ADD_FILE = 0x2;
const ADD_SUBDIRECTORY = 0x4;
const WRITE_EA = 0x10;
const DELETE_CHILD = 0x40;
const WRITE_ATTRIBUTES = 0x100;
const DELETE = 0x10000;
const WRITE_DAC = 0x40000;
const WRITE_OWNER = 0x80000;
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;
const FILE_ALL_ACCESS = 0x1f01ff;
const FILE_GENERIC_WRITE = 0x120116;
const CONTROL = WRITE_DAC | WRITE_OWNER;
const ROOT_FORBIDDEN = ADD_FILE | ADD_SUBDIRECTORY | WRITE_EA | DELETE_CHILD | WRITE_ATTRIBUTES | DELETE | CONTROL;
const REPARSE_POINT = 0x400;

/** Windows Error with a stable code, so the cache can map it to STAGING_UNAVAILABLE. */
const refusal = (message) => Object.assign(new Error(message), { code: 'DIRECTORY_UNTRUSTED' });

// Generic rights as they apply to directories.
function effectiveMask(mask) {
  let value = mask >>> 0;
  if (value & GENERIC_ALL) value |= FILE_ALL_ACCESS;
  if (value & GENERIC_WRITE) value |= FILE_GENERIC_WRITE;
  return value;
}

/**
 * Judges one reading (readWindowsDirectorySecurity) of a directory chain, ordered from the
 * directory in question up to its drive root. With `leaf`, the first directory is the cache root
 * and must be private as well. Returns null when less-trusted principals can neither replace any
 * directory on the chain nor (for a leaf) change anything in the root; otherwise the reason.
 *
 * @param {{ user: string, directories: Array<{ owner: string, attributes: number,
 *   rules: Array<{ sid: string, allow: boolean, mask: number, inheritOnly: boolean, inheritable: boolean }> }> }} reading
 * @param {{ leaf?: boolean }} [options]
 */
export function assessWindowsDirectoryChain(reading, { leaf = true } = {}) {
  const user = reading?.user;
  const directories = reading?.directories;
  if (typeof user !== 'string' || !/^S-1-\d+(-\d+)+$/.test(user)) return 'The current user cannot be identified.';
  if (!Array.isArray(directories) || directories.length === 0) return 'The directory chain could not be read.';
  const trusted = (sid) => sid === user || TRUSTED_SIDS.has(sid) || sid === OWNER_RIGHTS;
  const ignored = (sid) => sid.startsWith('S-1-15-') || CREATOR_SIDS.has(sid);

  // Rights less-trusted principals hold on a directory: effective ones, or (inherited too) also
  // those its inheritable entries pass on to what is created in it.
  function untrustedRights(directory, { inherited = false } = {}) {
    if (typeof directory?.owner !== 'string' || !Array.isArray(directory.rules)) return FILE_ALL_ACCESS;
    let rights = trusted(directory.owner) ? 0 : FILE_ALL_ACCESS;
    for (const rule of directory.rules) {
      if (typeof rule?.sid !== 'string' || typeof rule.allow !== 'boolean' || !Number.isFinite(rule.mask)) return FILE_ALL_ACCESS;
      if (!rule.allow || trusted(rule.sid) || ignored(rule.sid)) continue;
      if (!rule.inheritOnly || (inherited && rule.inheritable)) rights |= effectiveMask(rule.mask);
    }
    return rights;
  }

  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    if (!Number.isInteger(directory?.attributes) || (directory.attributes & REPARSE_POINT)) {
      return 'A directory on the preparation cache path is a link.';
    }
    if (!trusted(directory.owner)) return 'A directory on the preparation cache path belongs to another user.';
    const own = untrustedRights(directory);
    if (index === 0 && leaf && (untrustedRights(directory, { inherited: true }) & ROOT_FORBIDDEN)) {
      return 'Other users can change the preparation cache root.';
    }
    const parent = directories[index + 1];
    if (!parent) continue;
    const inParent = untrustedRights(parent);
    const removable = (own & (DELETE | CONTROL)) !== 0 || (inParent & (DELETE_CHILD | CONTROL)) !== 0;
    const addable = (inParent & (ADD_FILE | ADD_SUBDIRECTORY | CONTROL)) !== 0;
    if (removable && addable) return 'A directory on the preparation cache path can be replaced by another user.';
  }
  return null;
}

// ── Windows PowerShell bridge ───────────────────────────────────────────────────────────────

const READ_TIMEOUT_MS = 30_000;

function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot) || systemRoot.startsWith('\\\\')) {
    throw refusal('The Windows system directory is unknown.');
  }
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Creates `create` (in order, each a child of an existing directory) with a private, protected
// ACL, then reports owner, attributes and access rules (by SID) of every `read` directory.
// Paths travel as base64 JSON inside the script, never through a shell.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__REQUEST__')) | ConvertFrom-Json
$sidType = [System.Security.Principal.SecurityIdentifier]
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($directory in @($request.create)) {
  if ($null -eq $directory) { continue }
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($user, 'S-1-5-18', 'S-1-5-32-544')) {
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      (New-Object System.Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  if (-not [System.IO.Directory]::Exists($directory)) { [void][System.IO.Directory]::CreateDirectory($directory, $security) }
}
$directories = New-Object System.Collections.ArrayList
foreach ($directory in @($request.read)) {
  if ($null -eq $directory) { continue }
  $acl = [System.IO.Directory]::GetAccessControl($directory, [System.Security.AccessControl.AccessControlSections]'Owner,Access')
  $rules = New-Object System.Collections.ArrayList
  foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
    [void]$rules.Add([ordered]@{
      sid = $rule.IdentityReference.Value
      allow = ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow)
      mask = [int]$rule.FileSystemRights
      inheritOnly = (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
      inheritable = ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None)
    })
  }
  [void]$directories.Add([ordered]@{
    owner = $acl.GetOwner($sidType).Value
    attributes = [int][System.IO.File]::GetAttributes($directory)
    rules = $rules.ToArray()
  })
}
ConvertTo-Json -Compress -Depth 6 -InputObject ([ordered]@{ user = $user; directories = $directories.ToArray() })
`;

const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

function runPowerShell(request) {
  const script = SCRIPT.replace('__REQUEST__', Buffer.from(JSON.stringify(request), 'utf8').toString('base64'));
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(refusal('Directory permissions could not be read.'));
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout).trim());
        const directories = asArray(parsed?.directories).map((directory) => ({
          owner: directory?.owner,
          attributes: directory?.attributes,
          rules: asArray(directory?.rules),
        }));
        if (directories.length !== request.read.length) throw new Error('Incomplete reading.');
        resolve({ user: parsed?.user, directories });
      } catch {
        reject(refusal('Directory permissions could not be read.'));
      }
    });
  });
}

/**
 * Reads owner, attributes and access rules (by SID) of each directory, in order, and the SID of
 * the current user. Rejects (code DIRECTORY_UNTRUSTED) when any of it cannot be read.
 * @param {string[]} directories absolute local paths
 */
export async function readWindowsDirectorySecurity(directories) {
  if (process.platform !== 'win32') throw refusal('Windows directory permissions exist only on Windows.');
  return runPowerShell({ create: [], read: [...directories] });
}

/**
 * Creates each missing directory (in order: each must be a child of an existing one) with a
 * private ACL protected from inheritance: full control for this user, SYSTEM and Administrators,
 * inherited by everything created in it. A directory that already exists is left as it is (and
 * judged by its reading like any other).
 * @param {string[]} directories absolute local paths
 */
export async function createPrivateWindowsDirectories(directories) {
  if (process.platform !== 'win32') throw refusal('Windows directory permissions exist only on Windows.');
  await runPowerShell({ create: [...directories], read: [] });
}
