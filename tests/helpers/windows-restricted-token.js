// Windows test helpers for A3.3b-2 F7: test-owned directory ACLs and a lower-trust actor.
//
// The lower-trust actor is this user's own token restricted (CreateRestrictedToken) to the
// restricting SIDs Everyone, Authenticated Users and Users, with every privilege but traverse
// removed. Windows then grants it only what those groups are granted as well, exactly as for
// another ordinary user of the machine: it cannot read files private to this user, but can do
// whatever a directory grants "Authenticated Users". Its operations run on an impersonating thread
// of a short-lived Windows PowerShell process; nothing outside the paths a test passes is touched.
//
// Only test-owned temporary directories are ever given to these helpers.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let userSid = null;
/** The SID of the user running the tests. */
export function currentUserSid() {
  if (userSid) return userSid;
  const result = spawnSync(path.join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(result.stdout ?? '')?.[1];
  if (!sid) throw new Error('whoami /user failed: ' + result.stderr);
  userSid = sid;
  return sid;
}

function icacls(directory, ...args) {
  const result = spawnSync(path.join(SYSTEM32, 'icacls.exe'), [directory, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`icacls ${args.join(' ')} failed: ${result.stdout}${result.stderr}`);
}

/** Replaces a test-owned directory's ACL by this user, SYSTEM and Administrators only (inherited by its contents). */
export function makePrivate(directory) {
  icacls(directory, '/inheritance:r', '/grant:r',
    `*${currentUserSid()}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F');
}

/** Grants Authenticated Users Modify on a test-owned directory, inherited by everything below it. */
export function shareWithAuthenticatedUsers(directory) {
  icacls(directory, '/grant', '*S-1-5-11:(OI)(CI)M');
}

/** Removes that grant again. */
export function unshare(directory) {
  icacls(directory, '/remove:g', '*S-1-5-11');
}

const ACTOR = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class LowerTrustActor {
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string sid, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags,
    uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, SidAndAttributes[] restrict, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access,
    uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(IntPtr handle, uint code, byte[] input, int inputSize,
    IntPtr output, int outputSize, out int returned, IntPtr overlapped);

  static void Junction(string at, string target) {
    Directory.CreateDirectory(at);
    byte[] substitute = Encoding.Unicode.GetBytes(@"\??\" + target);
    byte[] print = Encoding.Unicode.GetBytes(target);
    int names = substitute.Length + 2 + print.Length + 2;
    byte[] buffer = new byte[16 + names];
    BitConverter.GetBytes(0xA0000003u).CopyTo(buffer, 0);
    BitConverter.GetBytes((ushort)(8 + names)).CopyTo(buffer, 4);
    BitConverter.GetBytes((ushort)0).CopyTo(buffer, 8);
    BitConverter.GetBytes((ushort)substitute.Length).CopyTo(buffer, 10);
    BitConverter.GetBytes((ushort)(substitute.Length + 2)).CopyTo(buffer, 12);
    BitConverter.GetBytes((ushort)print.Length).CopyTo(buffer, 14);
    substitute.CopyTo(buffer, 16);
    print.CopyTo(buffer, 16 + substitute.Length + 2);
    IntPtr handle = CreateFileW(at, 0x40000000, 0, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int returned;
    bool ok = DeviceIoControl(handle, 0x000900A4, buffer, buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    CloseHandle(handle);
    if (!ok) {
      try { Directory.Delete(at); } catch { }
      throw new Win32Exception(error);
    }
  }

  // Runs each operation (op, a, b) as the lower-trust actor; returns "ok" or the error per operation.
  public static string[] Run(string[][] operations) {
    IntPtr own, restricted;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0002 | 0x0008 | 0x0001, out own)) throw new Win32Exception();
    string[] sids = { "S-1-1-0", "S-1-5-11", "S-1-5-32-545" };
    SidAndAttributes[] restrict = new SidAndAttributes[sids.Length];
    for (int i = 0; i < sids.Length; i++) {
      if (!ConvertStringSidToSid(sids[i], out restrict[i].Sid)) throw new Win32Exception();
    }
    // DISABLE_MAX_PRIVILEGE: every privilege but SeChangeNotify (traverse) is removed.
    if (!CreateRestrictedToken(own, 0x1, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restrict.Length, restrict, out restricted)) throw new Win32Exception();
    string[] results = new string[operations.Length];
    if (!ImpersonateLoggedOnUser(restricted)) throw new Win32Exception();
    try {
      for (int i = 0; i < operations.Length; i++) {
        string[] op = operations[i];
        try {
          if (op[0] == "read") File.ReadAllBytes(op[1]);
          else if (op[0] == "move") Directory.Move(op[1], op[2]);
          else if (op[0] == "junction") Junction(op[1], op[2]);
          else if (op[0] == "delete") File.Delete(op[1]);
          else throw new ArgumentException(op[0]);
          results[i] = "ok";
        } catch (Exception err) {
          results[i] = err.GetType().Name + ": " + err.Message;
        }
      }
    } finally {
      RevertToSelf();
      CloseHandle(restricted);
      CloseHandle(own);
    }
    return results;
  }
}
`;

/**
 * Runs operations as the lower-trust actor, in order. Each is one of
 *   ['read', file]            read a file
 *   ['move', from, to]        rename a directory
 *   ['junction', at, target]  create a directory junction
 *   ['delete', file]          delete a file
 * and yields 'ok' or the error it met.
 */
export function asLowerTrustActor(operations) {
  const request = Buffer.from(JSON.stringify(operations), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition @'\n${ACTOR}\n'@`,
    `$operations = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json`,
    '$list = New-Object System.Collections.Generic.List[string[]]',
    'foreach ($op in $operations) { $list.Add([string[]]@($op)) }',
    '$results = [LowerTrustActor]::Run($list.ToArray())',
    'ConvertTo-Json -Compress -InputObject @($results)',
  ].join('\n');
  const result = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.status !== 0) throw new Error('Lower-trust actor failed: ' + result.stdout + result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}
