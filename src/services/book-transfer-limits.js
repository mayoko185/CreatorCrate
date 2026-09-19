import { MANAGED_IMAGE_LIMITS } from './managed-image-service.js';

const MIB = 1024 * 1024;
const MAXIMUM_BOOKS = 256;

export const BOOK_TRANSFER_LIMITS = Object.freeze({
  maximumBooks: MAXIMUM_BOOKS,
  maximumFileEntries: 1 + MAXIMUM_BOOKS,
  manifestBytes: 8 * MIB,
  coverBytes: MANAGED_IMAGE_LIMITS.bytes,
  totalUncompressedBytes: 64 * MIB,
  compressedArchiveBytes: 64 * MIB,
});

export function isBookTransferUncompressedSizeAllowed(byteLength) {
  return Number.isSafeInteger(byteLength)
    && byteLength >= 0
    && byteLength <= BOOK_TRANSFER_LIMITS.totalUncompressedBytes;
}
