// A3.3b-2 F7 — judging Windows directory ACLs for the comic preparation cache root.
// Pure readings (as readWindowsDirectorySecurity reports them) on every platform; the real
// Windows ACLs, PowerShell bridge and a lower-trust actor are exercised in
// comic-preparation-cache.test.js.
import { describe, expect, it } from 'vitest';
import { assessWindowsDirectoryChain } from '../src/services/windows-directory-trust.js';

const USER = 'S-1-5-21-1000-2000-3000-1001';
const OTHER_USER = 'S-1-5-21-1000-2000-3000-1002';
const AUTHENTICATED_USERS = 'S-1-5-11';
const USERS = 'S-1-5-32-545';
const CAPABILITY = 'S-1-15-3-1024-1-2-3';
const FULL = 0x1f01ff;
const MODIFY = 0x1301bf;
const READ_EXECUTE = 0x1200a9;
const CREATE_FOLDERS = 0x4;

const rule = (sid, mask, extra = {}) => ({ sid, allow: true, mask, inheritOnly: false, inheritable: true, ...extra });
const privateDir = (extra = []) => ({ owner: USER, attributes: 0x10, rules: [rule('S-1-5-18', FULL), rule('S-1-5-32-544', FULL), rule(USER, FULL), ...extra] });
// C:\ as shipped: Authenticated Users may create folders, and pass Modify to what they contain.
const driveRoot = () => ({
  owner: 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
  attributes: 0x16,
  rules: [rule(AUTHENTICATED_USERS, CREATE_FOLDERS, { inheritable: false }),
    rule(AUTHENTICATED_USERS, 0x10000 | 0x40000000 | 0x20000000 | 0x80000000, { inheritOnly: true }),
    rule('S-1-5-18', FULL), rule('S-1-5-32-544', FULL), rule(USERS, READ_EXECUTE)],
});
const assess = (directories, options) => assessWindowsDirectoryChain({ user: USER, directories }, options);

describe('Windows directory chain trust (F7)', () => {
  it('accepts a private root in a per-user temporary folder, even one a sandbox group may modify', () => {
    // As observed: %TEMP% grants another local group Modify, its parent only read access.
    const temp = privateDir([rule(OTHER_USER, MODIFY)]);
    const local = privateDir([rule(OTHER_USER, READ_EXECUTE), rule(CAPABILITY, FULL)]);
    expect(assess([privateDir(), temp, local, privateDir(), privateDir(), driveRoot()])).toBeNull();
  });

  it('refuses a directory others can both remove and replace (reviewer configuration)', () => {
    // <drive>\shared grants Authenticated Users Modify, inherited by <shared>\app.
    const shared = privateDir([rule(AUTHENTICATED_USERS, MODIFY)]);
    const app = privateDir([rule(AUTHENTICATED_USERS, MODIFY, { inheritable: true })]);
    expect(assess([privateDir(), app, shared, driveRoot()])).toMatch(/replaced/);
    // Removable but not replaceable (nothing can be added beside it), or the reverse: accepted.
    expect(assess([privateDir(), app, privateDir(), driveRoot()])).toBeNull();
    expect(assess([privateDir(), privateDir(), shared, privateDir(), driveRoot()])).toBeNull();
    // Delete-child on the parent removes any child; with add rights it replaces one.
    expect(assess([privateDir(), privateDir(), privateDir([rule(USERS, 0x40 | CREATE_FOLDERS)]), driveRoot()])).toMatch(/replaced/);
    // Control of the parent (WRITE_DAC / WRITE_OWNER / GENERIC_ALL) is both.
    expect(assess([privateDir(), privateDir(), privateDir([rule(USERS, 0x40000)]), driveRoot()])).toMatch(/replaced/);
    expect(assess([privateDir(), privateDir(), privateDir([rule(USERS, 0x10000000)]), driveRoot()])).toMatch(/replaced/);
  });

  it('refuses a root others can change, effectively or through what it passes on', () => {
    const chain = (root) => assess([root, privateDir(), driveRoot()]);
    expect(chain(privateDir([rule(AUTHENTICATED_USERS, CREATE_FOLDERS)]))).toMatch(/Other users/);
    expect(chain(privateDir([rule(USERS, MODIFY, { inheritOnly: true })]))).toMatch(/Other users/);
    expect(chain(privateDir([rule(USERS, 0x40000000, { inheritOnly: true })]))).toMatch(/Other users/);
    // Reading is not changing; deny entries only narrow; capabilities and creator placeholders grant nothing alone.
    expect(chain(privateDir([rule(USERS, READ_EXECUTE)]))).toBeNull();
    expect(chain(privateDir([{ ...rule(USERS, FULL), allow: false }]))).toBeNull();
    expect(chain(privateDir([rule(CAPABILITY, FULL), rule('S-1-3-0', FULL, { inheritOnly: true })]))).toBeNull();
    // For an existing ancestor checked before the root is created below it, only replacement counts.
    expect(assess([privateDir([rule(AUTHENTICATED_USERS, CREATE_FOLDERS)]), privateDir(), driveRoot()], { leaf: false })).toBeNull();
  });

  it('refuses foreign owners, links and anything it cannot read', () => {
    expect(assess([{ ...privateDir(), owner: OTHER_USER }, privateDir(), driveRoot()])).toMatch(/belongs to another user/);
    expect(assess([privateDir(), { ...privateDir(), owner: OTHER_USER }, driveRoot()])).toMatch(/another user/);
    expect(assess([privateDir(), { ...privateDir(), attributes: 0x410 }, driveRoot()])).toMatch(/link/);
    expect(assess([privateDir(), { ...privateDir(), attributes: undefined }, driveRoot()])).toMatch(/link/);
    expect(assess([privateDir([{ sid: USERS, allow: true }]), privateDir(), driveRoot()])).not.toBeNull();
    expect(assess([{ owner: USER, attributes: 0x10 }, privateDir(), driveRoot()])).not.toBeNull();
    expect(assess([])).not.toBeNull();
    expect(assessWindowsDirectoryChain({ user: 'nobody', directories: [privateDir(), driveRoot()] })).not.toBeNull();
    expect(assessWindowsDirectoryChain(null)).not.toBeNull();
    // Administrators, SYSTEM and TrustedInstaller are trusted; another user is not.
    expect(assess([privateDir(), { ...privateDir(), owner: 'S-1-5-32-544' }, driveRoot()])).toBeNull();
    expect(assessWindowsDirectoryChain({ user: OTHER_USER, directories: [privateDir(), privateDir(), driveRoot()] })).toMatch(/another user/);
  });
});
