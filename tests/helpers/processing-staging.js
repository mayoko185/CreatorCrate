import fs from 'node:fs';
import path from 'node:path';

// Every stage artifact is named `<16 hex operation token>.<name>` inside a fixed workspace.
const OPERATION_TOKEN = /^[0-9a-f]{16}\./;

// CreatorCrate retains its fixed per-kind staging workspaces: it never removes a directory
// whose creation it cannot prove. A workspace therefore "remains" for a test only while it
// still holds stage artifacts; returns the names of those workspaces.
export function stagingWorkspaces(projectDir, prefix) {
  return fs.readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)
      && fs.readdirSync(path.join(projectDir, entry.name)).length > 0)
    .map((entry) => entry.name);
}

// Stage artifact names in a workspace, without their per-operation token.
export function stageNames(workspaceAbsPath) {
  return fs.readdirSync(workspaceAbsPath).map((name) => name.replace(OPERATION_TOKEN, '')).sort();
}

// Path of the one retained stage artifact called `name`, whatever operation token it has.
export function stageArtifact(workspaceAbsPath, name) {
  const matches = fs.readdirSync(workspaceAbsPath)
    .filter((entry) => entry.replace(OPERATION_TOKEN, '') === name);
  if (matches.length > 1) throw new Error(`Ambiguous retained stage artifact ${name}.`);
  return path.join(workspaceAbsPath, matches[0] ?? name);
}
