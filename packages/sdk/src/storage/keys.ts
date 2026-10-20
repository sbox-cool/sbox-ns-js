// Mirrors SboxNetworkStorage.Storage.Relational/StoreValidation.cs and StorageIdValidation.cs.
const RECORD_KEY = /^[a-zA-Z0-9_:-]{1,256}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidRecordKey(key: string): boolean {
  return RECORD_KEY.test(key);
}

export function isValidId(id: string): boolean {
  return ID.test(id);
}

// Per-player records are stored as "<playerKey>" (legacy single slot) or "<playerKey>_<recordId>".
// Player keys are steam ids, which never contain "_", so the segment before the first "_" is the owner.
export function playerKeyOf(recordKey: string): string {
  const cut = recordKey.indexOf("_");
  return cut === -1 ? recordKey : recordKey.slice(0, cut);
}
