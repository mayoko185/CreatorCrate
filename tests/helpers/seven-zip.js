import SevenZip from '7z-wasm';

export async function read7zEntryNames(buffer) {
  const lines = [];
  const module = await SevenZip({ print: (line) => lines.push(line), printErr: () => {} });
  module.FS.writeFile('/archive.7z', buffer);
  // Listing reads archive indices; walking extracted directories can group interleaved paths.
  const exitCode = module.callMain(['l', '/archive.7z', '-slt', '-ba', '-bsp0']);
  if (exitCode !== 0) throw new Error('Could not list 7z archive entries.');
  return lines.filter((line) => line.startsWith('Path = ')).map((line) => line.slice(7));
}
