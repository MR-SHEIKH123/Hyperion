/**
 * One door for archives that arrive from outside the machine.
 *
 * `new AdmZip(bytes)` parses the container, but adm-zip 0.6.x validates
 * *entry extents* lazily — a crafted archive (a header announcing data past
 * the end of the file) is only rejected when some later read trips over it,
 * long after the construction-site `try` that the backup, skills and
 * resources paths use to turn an unreadable archive into a clean 400.
 * Left as-is, that surfaces as a 500 from the middle of a route.
 *
 * `openGuardedZip` does what those guards intend: construct, enumerate, and
 * pre-check that every entry's declared data extent actually lies inside the
 * buffer — before any caller reads, extracts, or allocates anything. It
 * throws a plain `Error` on the spot; each call site keeps its own
 * `catch` and maps the throw to its own `AppError`.
 *
 * This is *not* a size cap: the 0.6.x allocation bound (CVE-2026-39244) is
 * what stops a huge *declaration* from costing memory — test/zipcrafted.test.ts
 * proves that from outside. The pre-check here exists so the new version's
 * lazy refusal lands in the guards that were always meant to catch it.
 */
import AdmZip from 'adm-zip';

/** Construct, enumerate, and confirm every entry's extent is inside `bytes`. */
export function openGuardedZip(bytes: Buffer): AdmZip {
  const zip = new AdmZip(bytes);
  for (const entry of zip.getEntries()) {
    const offset = entry.header.offset;
    if (!Number.isInteger(offset) || offset < 0 || offset + 30 > bytes.length) {
      throw new Error(
        `entry "${entry.entryName}" has a local header at offset ${offset}, outside the ${bytes.length}-byte archive`,
      );
    }
    // The local header is the authority for where the data starts: its own
    // name and extra lengths sit between it and the bytes it announces.
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const extent = dataStart + entry.header.compressedSize;
    if (extent > bytes.length) {
      throw new Error(
        `entry "${entry.entryName}" declares data ending at byte ${extent}, past the end of the ${bytes.length}-byte archive`,
      );
    }
  }
  return zip;
}
